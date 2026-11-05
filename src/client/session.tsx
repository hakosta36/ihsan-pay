'use client';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import type { Snapshot } from '@/lib/types';
import { PrivyProvider, useSubscribeToJwtAuthWithFlag } from '@privy-io/react-auth';
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
} from '@solana/kit';
type AuthResult = { session: Session };
type PaymentResult = { id: string; status: string; signature: string | null; notice?: string };
type Responses = {
  'auth/register': AuthResult;
  'auth/login': AuthResult;
  'auth/demo': AuthResult;
  snapshot: Snapshot;
  'wallet/challenge': { bound: true; address: string } | { bound?: false; nonce: string };
  'wallet/bind': { ok: boolean };
  messages: { ok: boolean };
  'payments/prepare': PaymentResult & { transaction: string | null };
  'payments/submit': PaymentResult;
  'payments/reconcile': { checked: number; settled: number };
  faucet: PaymentResult;
};
type Api = <Path extends keyof Responses>(path: Path, data?: unknown) => Promise<Responses[Path]>;
const Context = createContext<{
  client: SupabaseClient;
  session: Session | null;
  api: Api;
} | null>(null);
export const useSession = () => {
  const value = useContext(Context);
  if (!value) throw new Error('Session provider is missing');
  return value;
};
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const client = useMemo(
    () =>
      createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        { auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false } },
      ),
    [],
  );
  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => {
    const { data } = client.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, [client]);
  async function api<Path extends keyof Responses>(
    path: Path,
    data?: unknown,
  ): Promise<Responses[Path]> {
    const { data: current } = await client.auth.getSession();
    const r = await fetch(`/api/${path}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(current.session ? { Authorization: `Bearer ${current.session.access_token}` } : {}),
      },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
    const json = await r.json();
    if (!r.ok) throw new Error(json.error || 'Request failed.');
    return json;
  }
  return (
    <Context.Provider value={{ client, session, api }}>
      <PrivyProvider
        appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID!}
        config={{
  appearance: {
    theme: 'light',
    accentColor: '#176347',
    walletChainType: 'solana-only',
  },
  embeddedWallets: {
    solana: {
      createOnLogin: 'users-without-wallets',
    },
  },
  solana: {
    rpcs: {
      'solana:devnet': {
        rpc: createSolanaRpc(
          'https://api.devnet.solana.com'
        ),
        rpcSubscriptions: createSolanaRpcSubscriptions(
          'wss://api.devnet.solana.com'
        ),
      },
    },
  },
}}
      >
        <JwtSync />
        {children}
      </PrivyProvider>
    </Context.Provider>
  );
}
function JwtSync() {
  const { client, session } = useSession();
  useSubscribeToJwtAuthWithFlag({
    isAuthenticated: Boolean(session),
    isLoading: false,
    getExternalJwt: async () => {
      const { data } = await client.auth.getSession();
      return data.session?.access_token;
    },
  });
  return null;
}
