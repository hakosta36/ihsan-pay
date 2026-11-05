import { describe, it, expect } from 'vitest';
import { Keypair, Transaction, SystemProgram } from '@solana/web3.js';
import { validateSignedTransaction } from '@/server/chain';
function fixture() {
  const sponsor = Keypair.generate(),
    user = Keypair.generate(),
    recipient = Keypair.generate();
  const tx = new Transaction({
    feePayer: sponsor.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  }).add(
    SystemProgram.transfer({
      fromPubkey: user.publicKey,
      toPubkey: recipient.publicKey,
      lamports: 10,
    }),
  );
  tx.partialSign(sponsor);
  const prepared = tx.serialize({ requireAllSignatures: false }).toString('base64');
  return { tx, prepared, user, sponsor };
}
describe('sponsor transaction validation', () => {
  it('accepts the exact user-approved message and preserves the network signature', () => {
    const { tx, prepared, user } = fixture();
    tx.partialSign(user);
    expect(
      validateSignedTransaction(prepared, tx.serialize().toString('base64')).signature,
    ).toEqual(tx.signature);
  });
  it('rejects a missing user signature', () => {
    const { prepared } = fixture();
    expect(() => validateSignedTransaction(prepared, prepared)).toThrow();
  });
  it('rejects modified instructions even if all signatures are valid', () => {
    const { tx, prepared, user, sponsor } = fixture();
    tx.instructions[0].data[4] = 99;
    tx.signatures = [];
    tx.partialSign(sponsor, user);
    expect(() => validateSignedTransaction(prepared, tx.serialize().toString('base64'))).toThrow(
      /does not match/,
    );
  });
  it('rejects arbitrary bytes', () =>
    expect(() => validateSignedTransaction('bad', 'bad')).toThrow());
});
