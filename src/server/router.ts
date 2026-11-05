import 'server-only';
import { after } from 'next/server';
import { randomBytes, verify, createPublicKey } from 'node:crypto';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import { db, publicAuth, check } from './db';
import { authenticate, usernameEmail } from './auth';
import { HttpError, body, limit, originGuard, route, sameSecret } from './http';
import { keypair, tokenBalance } from './chain';
import { broadcast, reserve, sendFaucet, reconcileBatch } from './payments';
import { receiveWebhook, drainWebhookInbox } from './webhooks';
import { required } from './config';
import type { Intent } from '@/lib/types';
const username = z.string().regex(/^[a-z][a-z0-9_]{2,23}$/);
const credentials = z.object({
  username,
  password: z.string().min(12).max(128),
  displayName: z.string().trim().min(1).max(60).optional(),
});
const paymentBody = z.object({ recipientId: z.uuid(), amount: z.string().max(20), key: z.uuid() });
const safePayment =
  'id,sender_id,recipient_id,amount,kind,status,signature,source_wallet,destination_wallet,created_at,finalized_at,slot,error_code';
export async function handle(req: Request, path: string) {
  return route(async () => {
    if (path === 'webhooks/helius' && req.method === 'POST') {
      const receipt = await receiveWebhook(req);
      after(async () => {
        try {
          await reconcileBatch();
          await drainWebhookInbox();
        } catch {
          console.error('Webhook reconciliation deferred to scheduled retry.');
        }
      });
      return receipt;
    }
    if (path === 'jobs/reconcile' && req.method === 'POST') {
      if (!sameSecret(req.headers.get('authorization') || '', `Bearer ${required('CRON_SECRET')}`))
        throw new HttpError(401, 'Not authorized.');
      const result = await reconcileBatch();
      await drainWebhookInbox();
      check(await db().from('worker_runs').insert(result));
      check(
        await db()
          .from('rate_limits')
          .delete()
          .lt('expires_at', new Date(Date.now() - 86400000).toISOString()),
      );
      // Drafts have never exposed a signable transaction; safe to release abandoned reservations.
      check(
        await db()
          .from('payments')
          .update({ status: 'expired', error_code: 'ABANDONED_DRAFT' })
          .eq('status', 'draft')
          .lt('created_at', new Date(Date.now() - 300000).toISOString()),
      );
      return result;
    }
    if (req.method === 'POST') originGuard(req);
    if (path === 'auth/register' && req.method === 'POST') {
      await limit(req, 'register', 5, 3600);
      const input = credentials.parse(await body(req));
      if (input.username === process.env.DEMO_HOST_USERNAME)
        throw new HttpError(409, 'Choose another username.');
      const created = await db().auth.admin.createUser({
        email: usernameEmail(input.username),
        password: input.password,
        email_confirm: true,
        user_metadata: {
          username: input.username,
          display_name: input.displayName || input.username,
        },
      });
      if (created.error)
        throw new HttpError(
          409,
          'This username is unavailable or the account could not be created.',
        );
      const { data, error } = await publicAuth().auth.signInWithPassword({
        email: usernameEmail(input.username),
        password: input.password,
      });
      if (error || !data.session) throw new HttpError(400, 'Account created. Sign in to continue.');
      return { session: data.session };
    }
    if (path === 'auth/login' && req.method === 'POST') {
      await limit(req, 'login', 15, 900);
      const input = credentials.parse(await body(req));
      const { data, error } = await publicAuth().auth.signInWithPassword({
        email: usernameEmail(input.username),
        password: input.password,
      });
      if (error || !data.session) throw new HttpError(401, 'Incorrect username or password.');
      return { session: data.session };
    }
    if (path === 'auth/demo' && req.method === 'POST') {
      await limit(req, 'demo-login', 20, 900);
      if (process.env.ENABLE_PUBLIC_DEMO_HOST !== 'true')
        throw new HttpError(403, 'Public host account is disabled.');
      const { data, error } = await publicAuth().auth.signInWithPassword({
        email: usernameEmail(required('DEMO_HOST_USERNAME')),
        password: required('DEMO_HOST_PASSWORD'),
      });
      if (error || !data.session) throw new HttpError(503, 'Seed the demo host account first.');
      return { session: data.session };
    }
    if (path === 'system' && req.method === 'GET') {
      await limit(req, 'system', 30, 60);
      const users = check(
        await db()
          .from('profiles')
          .select('id,username,display_name,wallet_address,created_at')
          .order('created_at', { ascending: false })
          .limit(30),
      );
      const balances = check(await db().from('balance_snapshots').select('*'));
      const payments = check(
        await db()
          .from('payments')
          .select(safePayment)
          .order('created_at', { ascending: false })
          .limit(40),
      );
      const events = check(
        await db()
          .from('webhook_events')
          .select('signature,received_at,processed_at,result')
          .order('received_at', { ascending: false })
          .limit(20),
      );
      const runs = check(
        await db()
          .from('worker_runs')
          .select('created_at,checked,settled')
          .order('created_at', { ascending: false })
          .limit(5),
      );
      const entries = check(
        await db()
          .from('ledger_entries')
          .select('payment_id,delta')
          .order('id', { ascending: false })
          .limit(80),
      );
      // This explicitly public demo observability view contains no credentials, auth IDs or private messages.
      return {
        users: (users || []).map(({ id, ...u }) => {
          const balance = (balances || []).find((b) => b.user_id === id);
          return {
            ...u,
            ...(balance
              ? { balance: balance.amount, balance_updated_at: balance.observed_at }
              : {}),
          };
        }),
        payments: (payments || []).map(({ sender_id: _s, recipient_id: _r, ...p }) => p),
        events,
        runs,
        journal: entries,
      };
    }
    const me = await authenticate(req);
    if (path === 'snapshot' && req.method === 'GET') {
      await limit(req, `snapshot:${me.id}`, 50, 60);
      const contacts = check(
        await db().from('profiles').select('*').neq('id', me.id).order('created_at').limit(30),
      );
      const payments = check(
        await db()
          .from('payments')
          .select(safePayment)
          .or(`sender_id.eq.${me.id},recipient_id.eq.${me.id}`)
          .order('created_at', { ascending: false })
          .limit(100),
      );
      const messages = check(
        await db()
          .from('messages')
          .select('*')
          .or(`sender_id.eq.${me.id},recipient_id.eq.${me.id}`)
          .order('created_at', { ascending: false })
          .limit(100),
      );
      const balance = me.wallet_address ? await tokenBalance(me.wallet_address) : '0';
      const observedAt = new Date().toISOString();
      check(
        await db()
          .from('balance_snapshots')
          .upsert({ user_id: me.id, amount: balance, observed_at: observedAt }),
      );
      return {
        me,
        contacts,
        payments,
        messages: (messages || []).reverse(),
        balance,
        balanceUpdatedAt: observedAt,
        faucetAddress: keypair('FAUCET_SECRET_KEY').publicKey.toBase58(),
        sponsorAddress: keypair('SPONSOR_SECRET_KEY').publicKey.toBase58(),
      };
    }
    if (path === 'wallet/challenge' && req.method === 'POST') {
      await limit(req, `challenge:${me.id}`, 10, 60);
      if (me.wallet_address) return { bound: true, address: me.wallet_address };
      const nonce = `Ihsan payment demo\nLink wallet to account ${me.id}\nOrigin: ${new URL(required('NEXT_PUBLIC_APP_URL')).origin}\nNonce: ${randomBytes(24).toString('hex')}`;
      check(
        await db()
          .from('wallet_challenges')
          .upsert({
            user_id: me.id,
            nonce,
            expires_at: new Date(Date.now() + 300000).toISOString(),
          }),
      );
      return { nonce };
    }
    if (path === 'wallet/bind' && req.method === 'POST') {
      await limit(req, `bind:${me.id}`, 10, 60);
      const input = z
        .object({
          address: z.string().max(60),
          signature: z.string().max(160),
          nonce: z.string().max(500),
        })
        .parse(await body(req));
      if (me.wallet_address) {
        if (me.wallet_address === input.address) return { ok: true };
        throw new HttpError(409, 'The account already has a wallet.');
      }
      const challenge = check(
        await db().from('wallet_challenges').select('*').eq('user_id', me.id).single(),
      );
      if (
        !challenge ||
        challenge.nonce !== input.nonce ||
        Date.parse(challenge.expires_at) < Date.now()
      )
        throw new HttpError(400, 'Wallet challenge expired. Try again.');
      let valid = false;
      try {
        const publicBytes = new PublicKey(input.address).toBuffer();
        const key = createPublicKey({
          key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicBytes]),
          format: 'der',
          type: 'spki',
        });
        valid = verify(null, Buffer.from(input.nonce), key, bs58.decode(input.signature));
      } catch {}
      if (!valid) throw new HttpError(400, 'Wallet ownership could not be verified.');
      const consumed = check(
        await db()
          .from('wallet_challenges')
          .delete()
          .eq('user_id', me.id)
          .eq('nonce', input.nonce)
          .select('user_id'),
      );
      if (!consumed?.length) throw new HttpError(409, 'Challenge already used.');
      check(
        await db()
          .from('profiles')
          .update({ wallet_address: input.address })
          .eq('id', me.id)
          .is('wallet_address', null),
      );
      return { ok: true };
    }
    if (path === 'messages' && req.method === 'POST') {
      await limit(req, `message:${me.id}`, 30, 60);
      const input = z
        .object({
          recipientId: z.uuid(),
          body: z.string().trim().min(1).max(2000),
          clientId: z.uuid(),
        })
        .parse(await body(req));
      if (input.recipientId === me.id) throw new HttpError(400, 'Choose another user.');
      const result = await db().from('messages').upsert(
        {
          sender_id: me.id,
          recipient_id: input.recipientId,
          body: input.body,
          client_id: input.clientId,
        },
        { onConflict: 'sender_id,client_id', ignoreDuplicates: true },
      );
      check(result);
      return { ok: true };
    }
    if (path === 'payments/prepare' && req.method === 'POST') {
      await limit(req, `prepare:${me.id}`, 10, 60);
      const input = paymentBody.parse(await body(req));
      const intent = await reserve(me, input.recipientId, input.key, input.amount, 'transfer');
      return {
        id: intent.id,
        status: intent.status,
        transaction: intent.status === 'prepared' ? intent.unsigned_transaction : null,
        signature: intent.signature,
      };
    }
    if (path === 'payments/submit' && req.method === 'POST') {
      await limit(req, `submit:${me.id}`, 15, 60);
      const input = z
        .object({ id: z.uuid(), transaction: z.string().max(5000) })
        .parse(await body(req));
      const intent = check(
        await db().from('payments').select('*').eq('id', input.id).eq('sender_id', me.id).single(),
      ) as Intent;
      if (!intent) throw new HttpError(404, 'Payment not found.');
      return broadcast(intent, input.transaction);
    }
    if (path === 'payments/reconcile' && req.method === 'POST') {
      await limit(req, `reconcile:${me.id}`, 6, 60);
      return reconcileBatch(me.id);
    }
    if (path === 'faucet' && req.method === 'POST') {
      await limit(req, 'faucet-ip', 10, 3600);
      const input = z.object({ key: z.uuid() }).parse(await body(req));
      return sendFaucet(me, input.key);
    }
    throw new HttpError(404, 'Endpoint not found.');
  });
}
