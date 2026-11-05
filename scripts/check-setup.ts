import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, getMint } from '@solana/spl-token';
import { createClient } from '@supabase/supabase-js';
import bs58 from 'bs58';
const required = [
  'NEXT_PUBLIC_APP_URL',
  'NEXT_PUBLIC_LEFT_PHONE_ORIGIN',
  'NEXT_PUBLIC_PRIVY_APP_ID',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SOLANA_RPC_URL',
  'USDC_MINT',
  'SPONSOR_SECRET_KEY',
  'FAUCET_SECRET_KEY',
  'HELIUS_WEBHOOK_SECRET',
  'CRON_SECRET',
  'RATE_LIMIT_SALT',
  'ALLOWED_ORIGINS',
  'DEMO_HOST_USERNAME',
  'DEMO_HOST_PASSWORD',
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) throw new Error(`Missing configuration: ${missing.join(', ')}`);
for (const name of ['HELIUS_WEBHOOK_SECRET', 'CRON_SECRET', 'RATE_LIMIT_SALT'])
  if (process.env[name]!.length < 32)
    throw new Error(`${name} must contain at least 32 characters.`);
if (
  new URL(process.env.NEXT_PUBLIC_LEFT_PHONE_ORIGIN!).origin ===
  new URL(process.env.NEXT_PUBLIC_APP_URL!).origin
)
  throw new Error('Two distinct origins are required for independent Privy sessions.');
const origins = process.env.ALLOWED_ORIGINS!.split(',').map((x) => x.trim());
for (const origin of [process.env.NEXT_PUBLIC_APP_URL!, process.env.NEXT_PUBLIC_LEFT_PHONE_ORIGIN!])
  if (!origins.includes(new URL(origin).origin))
    throw new Error('Both phone origins must appear in ALLOWED_ORIGINS.');
const rpc = new Connection(process.env.SOLANA_RPC_URL!, 'finalized');
if ((await rpc.getGenesisHash()) !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG')
  throw new Error('RPC is not Solana devnet. Refusing to continue.');
const mint = new PublicKey(process.env.USDC_MINT!);
if ((await getMint(rpc, mint)).decimals !== 6) throw new Error('Mint must have six decimals.');
for (const key of ['SPONSOR_SECRET_KEY', 'FAUCET_SECRET_KEY']) {
  const wallet = Keypair.fromSecretKey(bs58.decode(process.env[key]!));
  const sol = await rpc.getBalance(wallet.publicKey);
  let token = '0';
  try {
    token = (
      await rpc.getTokenAccountBalance(getAssociatedTokenAddressSync(mint, wallet.publicKey))
    ).value.amount;
  } catch {}
  console.log(
    `${key.replace('_SECRET_KEY', '')}: ${wallet.publicKey.toBase58()} | ${sol / 1e9} devnet SOL | ${BigInt(token) / 1_000_000n} test USDC`,
  );
  if (sol < 10_000_000) console.warn('Low devnet SOL. Fund this address before the demo.');
  if (key === 'FAUCET_SECRET_KEY' && BigInt(token) < 10_000_000n)
    console.warn('Faucet needs at least 10 test USDC.');
}
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);
for (const table of [
  'profiles',
  'payments',
  'messages',
  'ledger_entries',
  'webhook_events',
  'worker_runs',
  'balance_snapshots',
]) {
  const { error } = await db.from(table).select('*', { head: true, count: 'exact' });
  if (error) throw new Error(`Cannot read ${table}; apply the migration.`);
}
const jwks = await fetch(
  `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/.well-known/jwks.json`,
).then((r) => r.json());
if (!jwks.keys?.length)
  throw new Error(
    'Enable asymmetric Supabase Auth signing keys before configuring Privy custom auth.',
  );
console.log(
  'Base configuration is ready. Still verify Privy JWT settings, both allowed domains, Helius webhook and the Supabase cron job.',
);
