import 'server-only';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  getMint,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { required } from './config';
import { HttpError } from './http';
let connection: Connection | undefined;
export const rpc = () => (connection ??= new Connection(required('SOLANA_RPC_URL'), 'finalized'));
export const mint = () => new PublicKey(required('USDC_MINT'));
export const keypair = (name: 'SPONSOR_SECRET_KEY' | 'FAUCET_SECRET_KEY') =>
  Keypair.fromSecretKey(bs58.decode(required(name)));
export async function assertDevnet() {
  const genesis = await rpc().getGenesisHash();
  if (genesis !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG')
    throw new Error('Only Solana devnet is permitted.');
  const asset = await getMint(rpc(), mint(), 'finalized', TOKEN_PROGRAM_ID);
  if (asset.decimals !== 6) throw new Error('Configured mint must use six decimals.');
}
export async function tokenBalance(owner: string) {
  const ata = getAssociatedTokenAddressSync(mint(), new PublicKey(owner));
  const info = await rpc().getAccountInfo(ata, 'finalized');
  if (!info) return '0';
  return (await rpc().getTokenAccountBalance(ata, 'finalized')).value.amount;
}
export async function prepareTransfer(
  source: string,
  destination: string,
  amount: string,
  reference: string,
) {
  await assertDevnet();
  if (BigInt(await tokenBalance(source)) < BigInt(amount))
    throw new HttpError(409, 'Not enough test USDC.');
  const sponsor = keypair('SPONSOR_SECRET_KEY');
  const from = new PublicKey(source),
    to = new PublicKey(destination);
  const sourceAta = getAssociatedTokenAddressSync(mint(), from),
    destAta = getAssociatedTokenAddressSync(mint(), to);
  const latest = await rpc().getLatestBlockhash('finalized');
  const tx = new Transaction({
    feePayer: sponsor.publicKey,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  });
  tx.add(createAssociatedTokenAccountIdempotentInstruction(sponsor.publicKey, destAta, to, mint()));
  tx.add(createTransferCheckedInstruction(sourceAta, mint(), destAta, from, BigInt(amount), 6));
  tx.add(
    new TransactionInstruction({
      programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
      keys: [],
      data: Buffer.from(`ihsan-demo:${reference}`),
    }),
  );
  // The sponsor signature fixes the network transaction ID before any broadcast.
  tx.partialSign(sponsor);
  return {
    unsigned_transaction: tx.serialize({ requireAllSignatures: false }).toString('base64'),
    last_valid_block_height: latest.lastValidBlockHeight,
    signature: bs58.encode(tx.signatures[0].signature!),
  };
}
export function validateSignedTransaction(prepared: string, signed: string) {
  let expected: Transaction, actual: Transaction;
  try {
    expected = Transaction.from(Buffer.from(prepared, 'base64'));
    actual = Transaction.from(Buffer.from(signed, 'base64'));
  } catch {
    throw new HttpError(400, 'Invalid transaction.');
  }
  if (!actual.serializeMessage().equals(expected.serializeMessage()) || !actual.verifySignatures())
    throw new HttpError(
      400,
      'Transaction does not match the approved payment or is missing a signature.',
    );
  return actual;
}
