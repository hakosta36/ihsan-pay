import { beforeEach, describe, it, expect, vi } from 'vitest';
import { Keypair, Transaction, SystemProgram } from '@solana/web3.js';
import bs58 from 'bs58';
import type { Intent } from '@/lib/types';
const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  statuses: vi.fn(),
  transaction: vi.fn(),
  height: vi.fn(),
  update: vi.fn(),
  settle: vi.fn(),
  events: [] as string[],
}));
vi.mock('@/server/chain', async (original) => ({
  ...(await original<typeof import('@/server/chain')>()),
  assertDevnet: vi.fn(),
  rpc: () => ({
    sendRawTransaction: mocks.send,
    getSignatureStatuses: mocks.statuses,
    getTransaction: mocks.transaction,
    getBlockHeight: mocks.height,
  }),
}));
vi.mock('@/server/db', () => ({
  check: (r: { data: unknown; error: unknown }) => {
    if (r.error) throw r.error;
    return r.data;
  },
  db: () => ({
    rpc: mocks.settle,
    from: () => ({
      update: (data: unknown) => {
        mocks.events.push('persist');
        mocks.update(data);
        return { eq: () => ({ in: async () => ({ data: null, error: null }) }) };
      },
    }),
  }),
}));
import { broadcast, reconcile } from '@/server/payments';
function fixture() {
  const sponsor = Keypair.generate(),
    user = Keypair.generate(),
    receiver = Keypair.generate();
  const tx = new Transaction({
    feePayer: sponsor.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  }).add(
    SystemProgram.transfer({
      fromPubkey: user.publicKey,
      toPubkey: receiver.publicKey,
      lamports: 10,
    }),
  );
  tx.partialSign(sponsor);
  const unsigned = tx.serialize({ requireAllSignatures: false }).toString('base64');
  tx.partialSign(user);
  const intent: Intent = {
    id: crypto.randomUUID(),
    sender_id: crypto.randomUUID(),
    recipient_id: crypto.randomUUID(),
    amount: '5000000',
    kind: 'transfer',
    status: 'prepared',
    source_wallet: user.publicKey.toBase58(),
    destination_wallet: receiver.publicKey.toBase58(),
    signature: bs58.encode(tx.signatures[0].signature!),
    unsigned_transaction: unsigned,
    signed_transaction: null,
    last_valid_block_height: 100,
    created_at: new Date().toISOString(),
    finalized_at: null,
    slot: null,
    error_code: null,
  };
  return { intent, tx, signed: tx.serialize().toString('base64') };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.events.length = 0;
  mocks.send.mockImplementation(async () => {
    mocks.events.push('send');
    return 'signature';
  });
  mocks.settle.mockResolvedValue({ data: null, error: null });
});
describe('ambiguous broadcast and settlement recovery', () => {
  it('persists approved transaction bytes before any network send', async () => {
    const { intent, signed } = fixture();
    await broadcast(intent, signed);
    expect(mocks.events).toEqual(['persist', 'send']);
    expect(mocks.update.mock.calls[0][0].signed_transaction).toBe(signed);
  });
  it('keeps an RPC timeout pending and retries exactly the same signed bytes', async () => {
    const { intent, signed } = fixture();
    mocks.send.mockRejectedValue(new Error('timeout'));
    const first = await broadcast(intent, signed);
    await broadcast({ ...intent, status: 'submitted', signed_transaction: signed }, signed);
    expect(first.status).toBe('submitted');
    expect(mocks.send.mock.calls[0][0]).toEqual(mocks.send.mock.calls[1][0]);
    expect(mocks.settle).not.toHaveBeenCalled();
  });
  it('does not settle an unfinalized transaction', async () => {
    const { intent } = fixture();
    mocks.statuses.mockResolvedValue({ value: [{ confirmationStatus: 'confirmed', err: null }] });
    expect(await reconcile(intent)).toBe(false);
    expect(mocks.settle).not.toHaveBeenCalled();
  });
  it('verifies message bytes after finality before posting the journal', async () => {
    const { intent, tx } = fixture();
    mocks.statuses.mockResolvedValue({ value: [{ confirmationStatus: 'finalized', err: null }] });
    mocks.transaction.mockResolvedValue({
      slot: 42,
      meta: { err: null },
      transaction: { message: tx.compileMessage() },
    });
    expect(await reconcile(intent)).toBe(true);
    expect(mocks.settle).toHaveBeenCalledWith('settle_payment', { p_id: intent.id, p_slot: 42 });
  });
  it('rejects mismatched on-chain message bytes even if the status is finalized', async () => {
    const { intent } = fixture();
    const other = fixture();
    mocks.statuses.mockResolvedValue({ value: [{ confirmationStatus: 'finalized', err: null }] });
    mocks.transaction.mockResolvedValue({
      slot: 42,
      meta: { err: null },
      transaction: { message: other.tx.compileMessage() },
    });
    await expect(reconcile(intent)).rejects.toThrow('message mismatch');
    expect(mocks.settle).not.toHaveBeenCalled();
  });
  it('expires only after a finalized-height check when the signature is absent', async () => {
    const { intent } = fixture();
    mocks.statuses.mockResolvedValue({ value: [null] });
    mocks.height.mockResolvedValue(133);
    mocks.transaction.mockResolvedValue(null);
    await reconcile(intent);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'expired' }));
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
