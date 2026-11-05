import 'server-only';
import { z } from 'zod';
import { db, check } from './db';
import { HttpError, sameSecret } from './http';
import { required } from './config';
const signature = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,100}$/);
export function extractSignatures(payload: unknown): string[] {
  const events = z
    .array(
      z
        .object({
          signature: signature.optional(),
          transaction: z
            .object({ signatures: z.array(signature) })
            .passthrough()
            .optional(),
        })
        .passthrough(),
    )
    .max(100)
    .parse(payload);
  return [
    ...new Set(
      events.flatMap((e) =>
        e.signature ? [e.signature] : e.transaction?.signatures.slice(0, 1) || [],
      ),
    ),
  ];
}
export async function receiveWebhook(req: Request) {
  const expected = required('HELIUS_WEBHOOK_SECRET');
  if (expected.length < 32 || !sameSecret(req.headers.get('authorization') || '', expected))
    throw new HttpError(401, 'Invalid webhook authorization.');
  const text = await req.text();
  if (Buffer.byteLength(text) > 1_000_000) throw new HttpError(413, 'Webhook too large.');
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
  const signatures = extractSignatures(payload);
  for (const sig of signatures) {
    
    check(
      await db()
        .from('webhook_events')
        .upsert(
          { signature: sig, last_received_at: new Date().toISOString() },
          { onConflict: 'signature', ignoreDuplicates: true },
        ),
    );
  }
  return { received: signatures.length };
}
export async function drainWebhookInbox() {
  const events = check(
    await db()
      .from('webhook_events')
      .select('signature')
      .is('processed_at', null)
      .order('received_at')
      .limit(30),
  );
  for (const event of events || []) {
    const payment = check(
      await db()
        .from('payments')
        .select('id,status')
        .eq('signature', event.signature)
        .maybeSingle(),
    );
    // Provider amounts, account balances and claimed statuses are NEVER trusted.
    if (!payment || ['finalized', 'failed', 'expired'].includes(payment.status)) {
      check(
        await db()
          .from('webhook_events')
          .update({
            processed_at: new Date().toISOString(),
            result: payment ? payment.status : 'untracked',
          })
          .eq('signature', event.signature),
      );
    }
  }
  return events?.length || 0;
}
