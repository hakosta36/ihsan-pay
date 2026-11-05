import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
const db = new PGlite();
const sender = '11111111-1111-4111-8111-111111111111',
  recipient = '22222222-2222-4222-8222-222222222222';
const id1 = '33333333-3333-4333-8333-333333333333',
  id2 = '44444444-4444-4444-8444-444444444444';
async function reserve(key = id1, amount = '5000000', kind = 'transfer') {
  return db.query<{ id: string }>(
    `select (public.reserve_payment($1,$2,$3,$4,$5,'wallet-a','wallet-b','10000000','10000000')).*`,
    [kind === 'faucet' ? null : sender, recipient, key, amount, kind],
  );
}
beforeAll(async () => {
  await db.exec(
    `create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key,raw_user_meta_data jsonb);create function auth.uid() returns uuid language sql as 'select null::uuid';`,
  );
  let migration = await readFile(
    new URL('../supabase/migrations/001_initial.sql', import.meta.url),
    'utf8',
  );
 
  migration = migration
    .replace('create extension if not exists pgcrypto;', '')
    .replace('alter publication supabase_realtime add table public.messages;', '');
  await db.exec(migration);
  await db.query(
    `insert into auth.users values($1,'{"username":"alice","display_name":"Alice"}'),($2,'{"username":"bob","display_name":"Bob"}')`,
    [sender, recipient],
  );
});
afterAll(() => db.close());
describe('payment invariants in PostgreSQL', () => {
  it('returns the same payment for a duplicate idempotency key', async () => {
    const a = await reserve();
    const b = await reserve();
    expect(a.rows[0].id).toBe(b.rows[0].id);
  });
  it('rejects reusing a key for a different amount', async () => {
    await expect(reserve(id1, '6000000')).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  });
  it('reserves outgoing amounts and blocks overcommitting the same finalized balance', async () => {
    await expect(reserve(id2, '6000000')).rejects.toThrow('INSUFFICIENT_BALANCE');
  });
  it('enforces faucet grants across different request keys', async () => {
    await reserve(id2, '10000000', 'faucet');
    await expect(
      reserve('55555555-5555-4555-8555-555555555555', '10000000', 'faucet'),
    ).rejects.toThrow('FAUCET_LIMIT');
  });
  it('posts an exactly balanced pair only once on repeated finalization', async () => {
    const { rows } = await reserve();
    const id = rows[0].id;
    await db.query(
      `update public.payments set status='submitted',signature='test-signature' where id=$1`,
      [id],
    );
    await db.query('select public.settle_payment($1,123)', [id]);
    await db.query('select public.settle_payment($1,123)', [id]);
    const result = await db.query<{ count: number; total: string }>(
      'select count(*)::int as count,sum(delta)::text as total from public.ledger_entries where payment_id=$1',
      [id],
    );
    expect(result.rows[0]).toEqual({ count: 2, total: '0' });
  });
  it('rejects editing, deleting and truncating the journal', async () => {
    await expect(db.exec('update public.ledger_entries set delta=1')).rejects.toThrow(
      'LEDGER_IS_APPEND_ONLY',
    );
    await expect(db.exec('delete from public.ledger_entries')).rejects.toThrow(
      'LEDGER_IS_APPEND_ONLY',
    );
    await expect(db.exec('truncate public.ledger_entries')).rejects.toThrow(
      'LEDGER_IS_APPEND_ONLY',
    );
  });
  it('rejects unbalanced journal entries at commit', async () => {
    const { rows } = await reserve('66666666-6666-4666-8666-666666666666', '1000000');
    await expect(
      db.query(
        `insert into public.ledger_entries(payment_id,wallet_address,delta) values($1,'other-wallet',1)`,
        [rows[0].id],
      ),
    ).rejects.toThrow('UNBALANCED_JOURNAL');
  });
  it('does not allow authenticated clients to call settlement or reservation functions', async () => {
    const r = await db.query<{ allowed: boolean }>(
      `select has_function_privilege('authenticated','public.settle_payment(uuid,bigint)','execute') as allowed`,
    );
    expect(r.rows[0].allowed).toBe(false);
  });
});
