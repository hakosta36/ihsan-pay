
create extension if not exists pg_cron;
create extension if not exists pg_net;
select vault.create_secret('https://ihsan-pay-lab.vercel.app','ihsan_demo_origin');
select vault.create_secret('27a188e8520a360febe6c351a92dbe515d0cd669471d4fbfbbe39fcb16f4d96a','ihsan_demo_cron');
select cron.schedule('ihsan-payment-reconciliation','* * * * *',$$
 select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name='ihsan_demo_origin')||'/api/jobs/reconcile',
  headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='ihsan_demo_cron')),
  body := '{}'::jsonb, timeout_milliseconds := 25000
 );
$$);

