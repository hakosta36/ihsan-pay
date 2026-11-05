import { describe, it, expect } from 'vitest';
import { extractSignatures } from '@/server/webhooks';
const signature = '3'.repeat(88);
describe('webhook normalization', () => {
  it('accepts enhanced and raw events, deduplicated by chain signature', () =>
    expect(
      extractSignatures([{ signature }, { transaction: { signatures: [signature] } }]),
    ).toEqual([signature]));
  it('rejects malformed signatures and oversized batches', () => {
    expect(() => extractSignatures([{ signature: 'not-a-signature' }])).toThrow();
    expect(() => extractSignatures(Array(101).fill({ signature }))).toThrow();
  });
  it('never interprets provider token amounts as a ledger credit', () =>
    expect(
      extractSignatures([{ signature, tokenTransfers: [{ tokenAmount: 999999999 }] }]),
    ).toEqual([signature]));
});
