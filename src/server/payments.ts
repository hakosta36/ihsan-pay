import 'server-only';
import { Transaction } from '@solana/web3.js';
import { db, check } from './db';
import {
  assertDevnet,
  keypair,
  prepareTransfer,
  rpc,
  tokenBalance,
  validateSignedTransaction,
} from './chain';
import { HttpError } from './http';
import { parseAmount } from '@/lib/money';
import type { Intent, Profile } from '@/lib/types';
export async function reserve(
  me: Profile,
  recipientId: string,
  key: string,
  amount: string,
  kind: 'transfer' | 'faucet',
) {
  if (!me.wallet_address) throw new HttpError(409, 'Connect your wallet first.');
  const recipient = check(
    await db().from('profiles').select('*').eq('id', recipientId).single(),
  ) as Profile;
  if (!recipient.wallet_address)
    throw new HttpError(409, 'The recipient has not connected a wallet yet.');
  if (kind === 'transfer' && recipient.id === me.id)
    throw new HttpError(400, 'Choose another user.');
  const source =
    kind === 'faucet' ? keypair('FAUCET_SECRET_KEY').publicKey.toBase58() : me.wallet_address;
  const units = parseAmount(
    kind === 'faucet' ? process.env.FAUCET_AMOUNT || '10' : amount,
  ).toString();
  const balance = await tokenBalance(source);
  const result = await db().rpc('reserve_payment', {
    p_sender: kind === 'faucet' ? null : me.id,
    p_recipient: recipient.id,
    p_key: key,
    p_amount: units,
    p_kind: kind,
    p_source: source,
    p_destination: recipient.wallet_address,
    p_balance: balance,
    p_daily_limit: parseAmount(process.env.FAUCET_DAILY_LIMIT || '10').toString(),
  });
  if (result.error) {
    const message = result.error.message;
    if (message.includes('IDEMPOTENCY_CONFLICT'))
      throw new HttpError(409, 'This request key was already used for a different payment.');
    if (message.includes('FAUCET_LIMIT'))
      throw new HttpError(429, 'You have reached your test-funding limit. Try again in 24 hours.');
    if (message.includes('INSUFFICIENT_BALANCE'))
      throw new HttpError(
        409,
        'Not enough available test USDC. Another payment may still be pending.',
      );
    throw new Error('Payment reservation failed.');
  }
  let intent = result.data as Intent;
  if (intent.status !== 'draft') return intent;
  try {
    const prepared = await prepareTransfer(source, recipient.wallet_address, units, intent.id);
    // Only the CAS winner may hand its transaction to the client or broadcast it.
    const won = check(
      await db()
        .from('payments')
        .update({ ...prepared, status: 'prepared', updated_at: new Date().toISOString() })
        .eq('id', intent.id)
        .eq('status', 'draft')
        .select('*')
        .maybeSingle(),
    );
    intent = (won ||
      check(await db().from('payments').select('*').eq('id', intent.id).single())) as Intent;
  } catch (error) {
    // A transient preparation failure leaves a retryable draft; it has never been broadcast.
    throw error;
  }
  return intent;
}
export async function broadcast(intent: Intent, signed: string) {
  if (!intent.unsigned_transaction) throw new HttpError(409, 'Payment is not prepared.');
  if (['failed', 'expired'].includes(intent.status))
    throw new HttpError(409, 'This payment cannot be submitted. Create a new payment.');
  const tx = validateSignedTransaction(intent.unsigned_transaction, signed);
  const bytes = tx.serialize().toString('base64');
  if (intent.status === 'finalized')
    return { id: intent.id, status: intent.status, signature: intent.signature };
  await assertDevnet();
  // Durable signed bytes and a fixed signature are committed before the network call.
  check(
    await db()
      .from('payments')
      .update({
        signed_transaction: bytes,
        status: 'submitted',
        updated_at: new Date().toISOString(),
      })
      .eq('id', intent.id)
      .in('status', ['prepared', 'submitted']),
  );
  try {
    await rpc().sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 2,
      preflightCommitment: 'finalized',
    });
  } catch {
    // Timeout/preflight errors are ambiguous. Reconcile the SAME signature; never mint a fresh tx here.
    return {
      id: intent.id,
      status: 'submitted',
      signature: intent.signature,
      notice: 'Submission is being checked. Do not create another payment.',
    };
  }
  return { id: intent.id, status: 'submitted', signature: intent.signature };
}
export async function sendFaucet(me: Profile, key: string) {
  const intent = await reserve(me, me.id, key, '0', 'faucet');
  if (['submitted', 'finalized', 'failed', 'expired'].includes(intent.status))
    return { id: intent.id, status: intent.status, signature: intent.signature };
  const tx = Transaction.from(Buffer.from(intent.unsigned_transaction!, 'base64'));
  tx.partialSign(keypair('FAUCET_SECRET_KEY'));
  return broadcast(intent, tx.serialize().toString('base64'));
}
export async function reconcile(intent: Intent) {
  if (
    !intent.signature ||
    !intent.unsigned_transaction ||
    !['prepared', 'submitted'].includes(intent.status)
  )
    return false;
  const connection = rpc();
  const status = (
    await connection.getSignatureStatuses([intent.signature], { searchTransactionHistory: true })
  ).value[0];
  if (status?.confirmationStatus === 'finalized') {
    if (status.err) {
      check(
        await db()
          .from('payments')
          .update({
            status: 'failed',
            error_code: 'CHAIN_REJECTED',
            updated_at: new Date().toISOString(),
          })
          .eq('id', intent.id)
          .in('status', ['prepared', 'submitted']),
      );
      return false;
    }
    const found = await connection.getTransaction(intent.signature, {
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
    });
    if (!found || found.meta?.err || !found.meta) return false;
    const expected = Transaction.from(Buffer.from(intent.unsigned_transaction, 'base64'));
    if (!Buffer.from(found.transaction.message.serialize()).equals(expected.serializeMessage()))
      throw new Error('Finalized transaction message mismatch.');
    check(await db().rpc('settle_payment', { p_id: intent.id, p_slot: found.slot }));
    return true;
  }
  if (
    !status &&
    intent.last_valid_block_height &&
    (await connection.getBlockHeight('finalized')) > intent.last_valid_block_height + 32
  ) {
    // Re-check after the finalized-height observation; RPC responses may lag each other.
    const rechecked = (
      await connection.getSignatureStatuses([intent.signature], { searchTransactionHistory: true })
    ).value[0];
    if (rechecked) return false;
    const late = await connection.getTransaction(intent.signature, {
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
    });
    if (late) {
      
      if (!late.meta) return false;
      if (!late.meta.err) {
        const expected = Transaction.from(Buffer.from(intent.unsigned_transaction, 'base64'));
        if (!Buffer.from(late.transaction.message.serialize()).equals(expected.serializeMessage()))
          throw new Error('Finalized transaction message mismatch.');
        check(await db().rpc('settle_payment', { p_id: intent.id, p_slot: late.slot }));
        return true;
      }
      check(
        await db()
          .from('payments')
          .update({
            status: 'failed',
            error_code: 'CHAIN_REJECTED',
            updated_at: new Date().toISOString(),
          })
          .eq('id', intent.id)
          .in('status', ['prepared', 'submitted']),
      );
      return false;
    }
    check(
      await db()
        .from('payments')
        .update({
          status: 'expired',
          error_code: 'BLOCKHASH_EXPIRED',
          updated_at: new Date().toISOString(),
        })
        .eq('id', intent.id)
        .in('status', ['prepared', 'submitted']),
    );
  } else if (intent.signed_transaction) {
    // Safe retry: byte-for-byte identical transaction, identical signature.
    try {
      await connection.sendRawTransaction(Buffer.from(intent.signed_transaction, 'base64'), {
        maxRetries: 0,
        skipPreflight: false,
        preflightCommitment: 'finalized',
      });
    } catch {}
  }
  return false;
}
export async function reconcileBatch(userId?: string) {
  await assertDevnet();
  let q = db()
    .from('payments')
    .select('*')
    .in('status', ['prepared', 'submitted'])
    .order('updated_at')
    .limit(12);
  if (userId) q = q.or(`sender_id.eq.${userId},recipient_id.eq.${userId}`);
  const intents = check(await q) as Intent[];
  let settled = 0;
  for (const intent of intents) {
    if (await reconcile(intent)) settled++;
  }
  return { checked: intents.length, settled };
}
