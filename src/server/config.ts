import 'server-only';
export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing server configuration: ${name}`);
  return value;
}
export const publicConfigReady = () =>
  Boolean(
    process.env.NEXT_PUBLIC_PRIVY_APP_ID &&
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
