begin;
create extension if not exists pgcrypto;
create table public.profiles (
 id uuid primary key references auth.users(id),
 username text not null unique check (username ~ '^[a-z][a-z0-9_]{2,23}$'),
 display_name text not null check(char_length(display_name) between 1 and 60),
 wallet_address text unique,
 created_at timestamptz not null default now()
);
create table public.wallet_challenges (
 user_id uuid primary key references public.profiles(id), nonce text not null, expires_at timestamptz not null
);
create table public.messages (
 id uuid primary key default gen_random_uuid(), client_id uuid not null,
 sender_id uuid not null references public.profiles(id), recipient_id uuid not null references public.profiles(id),
 body text not null check(char_length(body) between 1 and 2000), created_at timestamptz not null default now(),
 unique(sender_id,client_id),check(sender_id<>recipient_id)
);
create index messages_recipient_created on public.messages(recipient_id,created_at desc);
create index messages_sender_created on public.messages(sender_id,created_at desc);
create table public.payments (
 id uuid primary key default gen_random_uuid(), idempotency_key uuid not null,
 sender_id uuid references public.profiles(id), recipient_id uuid not null references public.profiles(id),
 kind text not null check(kind in ('transfer','faucet')),
 amount text not null check(amount ~ '^[1-9][0-9]{0,15}$'),
 source_wallet text not null, destination_wallet text not null,
 status text not null default 'draft' check(status in ('draft','prepared','submitted','finalized','failed','expired')),
 unsigned_transaction text, signed_transaction text, signature text unique,
 last_valid_block_height bigint, slot bigint, error_code text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),finalized_at timestamptz,
 unique(sender_id,idempotency_key),check(source_wallet<>destination_wallet),
 check ((kind='transfer' and sender_id is not null and sender_id<>recipient_id) or (kind='faucet' and sender_id is null))
);
create unique index faucet_idempotency on public.payments(recipient_id,idempotency_key) where kind='faucet';
create index payments_pending on public.payments(updated_at) where status in ('draft','prepared','submitted');
create index payments_recipient_created on public.payments(recipient_id,created_at desc);
create index payments_sender_created on public.payments(sender_id,created_at desc);
create table public.ledger_entries (
 id bigint generated always as identity primary key,
 payment_id uuid not null references public.payments(id),wallet_address text not null,
 delta numeric(30,0) not null check(delta<>0 and delta::text not in ('NaN','Infinity','-Infinity')),
 created_at timestamptz not null default now(), unique(payment_id,wallet_address)
);
create table public.webhook_events (
 signature text primary key, received_at timestamptz not null default now(), last_received_at timestamptz not null default now(),
 deliveries integer not null default 1, processed_at timestamptz, result text not null default 'queued'
);
create table public.rate_limits (key text primary key, count integer not null, expires_at timestamptz not null);
create table public.balance_snapshots (user_id uuid primary key references public.profiles(id),amount text not null check(amount ~ '^[0-9]+$'),observed_at timestamptz not null default now());
alter table public.balance_snapshots enable row level security;
revoke all on public.balance_snapshots from anon,authenticated;
create table public.worker_runs (id uuid primary key default gen_random_uuid(),created_at timestamptz not null default now(),checked integer not null default 0,settled integer not null default 0);

create function public.create_profile() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.profiles(id,username,display_name) values(new.id,new.raw_user_meta_data->>'username',new.raw_user_meta_data->>'display_name');
 return new;
end;$$;
create trigger auth_user_created after insert on auth.users for each row execute function public.create_profile();

create function public.take_rate_limit(p_key text,p_limit int,p_seconds int) returns boolean language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 insert into public.rate_limits as r(key,count,expires_at) values(p_key,1,now()+make_interval(secs=>p_seconds))
 on conflict(key) do update set count=case when r.expires_at<now() then 1 else r.count+1 end,
 expires_at=case when r.expires_at<now() then now()+make_interval(secs=>p_seconds) else r.expires_at end returning count into n;
 return n<=p_limit;
end;$$;

-- Serializes outgoing reservations. No external RPC work is held inside a SQL transaction.
create function public.reserve_payment(p_sender uuid,p_recipient uuid,p_key uuid,p_amount text,p_kind text,p_source text,p_destination text,p_balance text,p_daily_limit text)
 returns public.payments language plpgsql security definer set search_path='' as $$
declare existing public.payments; reserved numeric; granted numeric; result public.payments;
begin
 perform pg_advisory_xact_lock(hashtextextended(coalesce(p_sender,p_recipient)::text,0));
 select * into existing from public.payments where idempotency_key=p_key and
 ((p_kind='transfer' and sender_id=p_sender) or (p_kind='faucet' and recipient_id=p_recipient and kind='faucet'));
 if found then
  if existing.amount<>p_amount or existing.recipient_id<>p_recipient or existing.source_wallet<>p_source or existing.destination_wallet<>p_destination or existing.kind<>p_kind then raise exception 'IDEMPOTENCY_CONFLICT';end if;
  return existing;
 end if;
 if p_amount !~ '^[1-9][0-9]{0,15}$' then raise exception 'INVALID_AMOUNT';end if;
 if p_kind='transfer' then
  select coalesce(sum(amount::numeric),0) into reserved from public.payments where sender_id=p_sender and status in ('draft','prepared','submitted');
  if reserved+p_amount::numeric>p_balance::numeric then raise exception 'INSUFFICIENT_BALANCE';end if;
 else
  select coalesce(sum(amount::numeric),0) into granted from public.payments where recipient_id=p_recipient and kind='faucet' and created_at>now()-interval '24 hours' and status not in ('failed','expired');
  if granted+p_amount::numeric>p_daily_limit::numeric then raise exception 'FAUCET_LIMIT';end if;
 end if;
 insert into public.payments(sender_id,recipient_id,idempotency_key,amount,kind,source_wallet,destination_wallet)
 values(p_sender,p_recipient,p_key,p_amount,p_kind,p_source,p_destination) returning * into result;
 return result;
end;$$;

create function public.settle_payment(p_id uuid,p_slot bigint) returns void language plpgsql security definer set search_path='' as $$
declare p public.payments;
begin
 select * into p from public.payments where id=p_id for update;
 if not found then raise exception 'UNKNOWN_PAYMENT';end if;
 if p.status='finalized' then return;end if;
 if p.signature is null or p.status not in ('prepared','submitted') then raise exception 'INVALID_TRANSITION';end if;
 insert into public.ledger_entries(payment_id,wallet_address,delta) values(p.id,p.source_wallet,-p.amount::numeric),(p.id,p.destination_wallet,p.amount::numeric);
 update public.payments set status='finalized',slot=p_slot,finalized_at=now(),updated_at=now(),error_code=null where id=p_id;
end;$$;
create function public.reject_ledger_mutation() returns trigger language plpgsql set search_path='' as $$begin raise exception 'LEDGER_IS_APPEND_ONLY';end;$$;
create trigger ledger_immutable before update or delete on public.ledger_entries for each row execute function public.reject_ledger_mutation();
create trigger ledger_no_truncate before truncate on public.ledger_entries for each statement execute function public.reject_ledger_mutation();
create function public.check_ledger_balance() returns trigger language plpgsql set search_path='' as $$
begin
 if (select sum(delta)<>0 or count(*)<>2 from public.ledger_entries where payment_id=new.payment_id) then raise exception 'UNBALANCED_JOURNAL';end if;
 return null;
end;$$;
create constraint trigger ledger_balanced after insert on public.ledger_entries deferrable initially deferred for each row execute function public.check_ledger_balance();

alter table public.profiles enable row level security;
alter table public.messages enable row level security;
alter table public.payments enable row level security;
alter table public.wallet_challenges enable row level security;
alter table public.ledger_entries enable row level security;
alter table public.webhook_events enable row level security;
alter table public.rate_limits enable row level security;
alter table public.worker_runs enable row level security;
-- Browser writes always pass through authenticated, validated backend endpoints.
revoke all on public.profiles,public.messages,public.payments,public.wallet_challenges,public.ledger_entries,public.webhook_events,public.rate_limits,public.worker_runs from anon,authenticated;
grant select on public.messages to authenticated;
create policy own_messages on public.messages for select to authenticated using(auth.uid()=sender_id or auth.uid()=recipient_id);
-- Broadcast contains only participant-visible chat data; balances and receipts use the API.
alter publication supabase_realtime add table public.messages;
revoke all on function public.create_profile() from public,anon,authenticated;
revoke all on function public.take_rate_limit(text,int,int) from public,anon,authenticated;
revoke all on function public.reserve_payment(uuid,uuid,uuid,text,text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.settle_payment(uuid,bigint) from public,anon,authenticated;
revoke all on function public.reject_ledger_mutation() from public,anon,authenticated;
revoke all on function public.check_ledger_balance() from public,anon,authenticated;
grant execute on function public.take_rate_limit(text,int,int),public.reserve_payment(uuid,uuid,uuid,text,text,text,text,text,text),public.settle_payment(uuid,bigint) to service_role;
grant all on public.profiles,public.messages,public.payments,public.wallet_challenges,public.ledger_entries,public.webhook_events,public.rate_limits,public.worker_runs,public.balance_snapshots to service_role;
grant usage,select on all sequences in schema public to service_role;
commit;
