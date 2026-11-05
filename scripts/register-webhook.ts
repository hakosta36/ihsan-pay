import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
};
const secret = env('HELIUS_WEBHOOK_SECRET');
if (secret.length < 32) throw new Error('Webhook secret must have at least 32 characters.');
const origin = new URL(env('NEXT_PUBLIC_APP_URL'));
if (origin.protocol !== 'https:')
  throw new Error('Deploy first: Helius needs a public HTTPS endpoint.');
const addresses = ['SPONSOR_SECRET_KEY', 'FAUCET_SECRET_KEY'].map((name) =>
  Keypair.fromSecretKey(bs58.decode(env(name))).publicKey.toBase58(),
);
const existing = process.env.HELIUS_WEBHOOK_ID;
const response = await fetch(
  `https://api.helius.xyz/v0/webhooks${existing ? '/' + encodeURIComponent(existing) : ''}?api-key=${encodeURIComponent(env('HELIUS_API_KEY'))}`,
  {
    method: existing ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      webhookURL: `${origin.origin}/api/webhooks/helius`,
      transactionTypes: ['ANY'],
      accountAddresses: addresses,
      webhookType: 'rawDevnet',
      authHeader: secret,
    }),
  },
);
if (!response.ok)
  throw new Error(
    `Helius rejected registration (${response.status}). Check devnet webhook access in your account. No paid plan is automatically enabled.`,
  );
const data = await response.json();
console.log('Webhook configured. Save this non-secret ID as HELIUS_WEBHOOK_ID:', data.webhookID);
console.log(
  'Sponsor monitoring covers app-originated transfers for all users. Reconciliation also runs independently of webhook delivery.',
);
