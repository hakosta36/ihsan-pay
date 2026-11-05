export const DECIMALS = 6;
export function parseAmount(value: string): bigint {
  if (!/^(0|[1-9]\d{0,6})(\.\d{1,6})?$/.test(value))
    throw new Error('Enter a positive amount with up to 6 decimals.');
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (amount <= 0n || amount > 1_000_000_000n)
    throw new Error('Amount must be between 0.000001 and 1,000 test USDC.');
  return amount;
}
export function formatAmount(value: string | bigint): string {
  const n = BigInt(value);
  const absolute = n < 0n ? -n : n;
  const fraction = (absolute % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${n < 0n ? '-' : ''}${absolute / 1_000_000n}${fraction ? '.' + fraction : ''}`;
}
export function shortAddress(value: string) {
  return value ? `${value.slice(0, 6)}…${value.slice(-5)}` : 'Not connected';
}
export const explorer = (signature: string) =>
  `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;
