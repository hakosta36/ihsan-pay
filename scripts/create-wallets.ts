import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { mkdir, writeFile } from 'node:fs/promises';
const sponsor = Keypair.generate(),
  faucet = Keypair.generate();
await mkdir('.keys', { recursive: true, mode: 0o700 });
await writeFile(
  '.keys/devnet-wallets.env',
  `SPONSOR_SECRET_KEY=${bs58.encode(sponsor.secretKey)}\nFAUCET_SECRET_KEY=${bs58.encode(faucet.secretKey)}\n`,
  { mode: 0o600, flag: 'wx' },
);
console.log(
  'Devnet-only keys saved to .keys/devnet-wallets.env (never commit or share this file).',
);
console.log('Sponsor public address:', sponsor.publicKey.toBase58());
console.log('Faucet public address:', faucet.publicKey.toBase58());
console.log(
  'Fund BOTH addresses with devnet SOL. Fund the FAUCET address with Circle devnet USDC.',
);
