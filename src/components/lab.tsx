'use client';
import { useEffect, useState } from 'react';
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  Database,
  ExternalLink,
  Layers3,
  MessageCircle,
  RefreshCw,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import { formatAmount, shortAddress, explorer } from '@/lib/money';
type SystemData = {
  users: {
    username: string;
    display_name: string;
    wallet_address: string | null;
    created_at: string;
    balance?: string;
    balance_updated_at?: string;
  }[];
  payments: {
    id: string;
    status: string;
    amount: string;
    kind: string;
    signature: string | null;
    created_at: string;
    source_wallet: string;
    destination_wallet: string;
  }[];
  events: { signature: string; result: string; received_at: string; processed_at: string | null }[];
  runs: { created_at: string; checked: number; settled: number }[];
  journal: { payment_id: string; delta: string }[];
};
export function Lab({ configured, leftOrigin }: { configured: boolean; leftOrigin: string }) {
  const [tab, setTab] = useState<'app' | 'system'>('app');
  return (
    <div className="lab">
      <header className="lab-header">
        <a className="brand" href="/" aria-label="Ihsan Payments Lab home">
          <span className="brand-mark">i</span>
          <strong>
            ihsan<span> / payments lab</span>
          </strong>
        </a>
        <div className="network">
          <span />
          Solana Devnet
        </div>
        <a
          className="text-link"
          href="https://explorer.solana.com/?cluster=devnet"
          target="_blank"
          rel="noreferrer"
        >
          Explorer <ArrowUpRight size={15} />
        </a>
      </header>
      <main>
        <div className="lab-heading">
          <div>
            <p className="intro-label">An independent engineering prototype</p>
            <h1>Money, inside the conversation.</h1>
            <p>Two accounts. Two wallets. One real transfer.</p>
          </div>
          <div className="lab-tabs" role="tablist" aria-label="Lab views">
            <button role="tab" aria-selected={tab === 'app'} onClick={() => setTab('app')}>
              <Smartphone size={17} />
              Application
            </button>
            <button role="tab" aria-selected={tab === 'system'} onClick={() => setTab('system')}>
              <Database size={17} />
              System view
            </button>
          </div>
        </div>
        <div hidden={tab !== 'app'}>
          <div className="workspace">
            <aside className="lab-guide">
              <span className="guide-icon">
                <MessageCircle size={25} />
              </span>
              <h2>A payment should feel like a message.</h2>
              <p>
                Create an account on the right, add test funds, then send a payment to the account
                on the left.
              </p>
              <ol>
                <li>
                  <span>1</span>
                  <div>
                    <strong>Meet your wallet</strong>
                    <p>Sign in and activate your personal Solana wallet.</p>
                  </div>
                </li>
                <li>
                  <span>2</span>
                  <div>
                    <strong>Add test USDC</strong>
                    <p>Real devnet tokens. No real money.</p>
                  </div>
                </li>
                <li>
                  <span>3</span>
                  <div>
                    <strong>Send in the chat</strong>
                    <p>Approve a payment and follow its receipt.</p>
                  </div>
                </li>
              </ol>
              <div className="guide-note">
                <ShieldCheck size={18} />
                <span>You authorize the transfer. The application pays the network fee.</span>
              </div>
            </aside>
            <div className="phones">
              <PhoneFrame
                label="The other side"
                detail="Shared test account"
                src={leftOrigin ? `${leftOrigin.replace(/\/$/, '')}/phone?side=host` : null}
                configured={configured}
              />
              <PhoneFrame
                label="Your account"
                detail="Create an account to begin"
                src="/phone?side=guest"
                configured={configured}
              />
            </div>
          </div>
          <div className="understage">
            <span>
              <Layers3 size={16} />
              Next.js · TypeScript · PostgreSQL · Privy · Solana
            </span>
            <span>
              Transfers settle only after blockchain finality.
              <Check size={15} />
            </span>
          </div>
        </div>
        {tab === 'system' && <SystemView configured={configured} />}
      </main>
      <footer className="lab-footer">
        <span>Built as a technical portfolio project. Not an official Ihsan product.</span>
        <span>Devnet only. Tokens have no monetary value.</span>
      </footer>
    </div>
  );
}
function PhoneFrame({
  label,
  detail,
  src,
  configured,
}: {
  label: string;
  detail: string;
  src: string | null;
  configured: boolean;
}) {
  return (
    <div className="phone-column">
      <div className="phone-label">
        <strong>{label}</strong>
        <span>{detail}</span>
      </div>
      <div className="device">
        <div className="device-camera" />
        <div className="device-screen">
          {configured && src ? (
            <iframe
              title={label}
              src={src}
              allow="clipboard-write; publickey-credentials-get *; publickey-credentials-create *"
            />
          ) : (
            <div className="device-setup">
              <span className="brand-mark">i</span>
              <h2>Ready to connect.</h2>
              <p>
                {!configured
                  ? 'Add the Supabase and Privy environment variables to start the live application.'
                  : 'Set NEXT_PUBLIC_LEFT_PHONE_ORIGIN to a second origin to isolate the two wallet sessions.'}
              </p>
              <span className="setup-pill">Configuration required</span>
            </div>
          )}
        </div>
        <div className="home-indicator" />
      </div>
      {src && configured && (
        <a className="open-phone" href={src} target="_blank" rel="noreferrer">
          Open separately <ExternalLink size={12} />
        </a>
      )}
    </div>
  );
}
function SystemView({ configured }: { configured: boolean }) {
  const [data, setData] = useState<SystemData | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false);
  async function load() {
    if (!configured) return;
    setLoading(true);
    try {
      const r = await fetch('/api/system');
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setData(j);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15000);
    return () => clearInterval(timer);
  }, [configured]); // Public curated demo data only.
  return (
    <section className="system">
      <div className="system-heading">
        <div>
          <h2>Behind the payment.</h2>
          <p>Read-only demo records. No credentials, private messages or editing controls.</p>
        </div>
        <button
          className="quiet-button"
          onClick={() => void load()}
          disabled={loading || !configured}
        >
          <RefreshCw size={15} className={loading ? 'spin' : ''} />
          Refresh
        </button>
      </div>
      {!configured && (
        <p className="notice">Connect Supabase and apply the SQL migration to view live records.</p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="system-metrics">
        <div>
          <span>Registered accounts</span>
          <strong>{data?.users.length ?? '—'}</strong>
        </div>
        <div>
          <span>Finalized payments</span>
          <strong>{data?.payments.filter((p) => p.status === 'finalized').length ?? '—'}</strong>
        </div>
        <div>
          <span>Webhook receipts</span>
          <strong>{data?.events.length ?? '—'}</strong>
        </div>
        <div>
          <span>Last reconciliation</span>
          <strong className="small-metric">
            {data?.runs[0]
              ? new Date(data.runs[0].created_at).toLocaleTimeString()
              : 'Awaiting run'}
          </strong>
        </div>
      </div>
      <h3>Accounts</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th>Solana wallet</th>
              <th>Last observed USDC</th>
              <th>Joined</th>
            </tr>
          </thead>
          <tbody>
            {data?.users.map((u) => (
              <tr key={u.username}>
                <td>
                  <strong>{u.display_name}</strong>
                  <small>@{u.username}</small>
                </td>
                <td>{u.wallet_address ? shortAddress(u.wallet_address) : 'Awaiting activation'}</td>
                <td>
                  {u.balance !== undefined ? formatAmount(u.balance) : 'Not observed'}
                  <small>
                    {u.balance_updated_at
                      ? new Date(u.balance_updated_at).toLocaleTimeString()
                      : ''}
                  </small>
                </td>
                <td>{new Date(u.created_at).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Payment journal</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Payment</th>
              <th>From / To</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Network receipt</th>
            </tr>
          </thead>
          <tbody>
            {data?.payments.map((p) => (
              <tr key={p.id}>
                <td>
                  <strong>{p.kind === 'faucet' ? 'Test funding' : 'Transfer'}</strong>
                  <small>{new Date(p.created_at).toLocaleString()}</small>
                </td>
                <td>
                  {shortAddress(p.source_wallet)}
                  <small>{shortAddress(p.destination_wallet)}</small>
                </td>
                <td>{formatAmount(p.amount)} USDC</td>
                <td>
                  <span className={`status ${p.status}`}>{p.status}</span>
                </td>
                <td>
                  {p.signature ? (
                    <a href={explorer(p.signature)} target="_blank" rel="noreferrer">
                      View transaction <ArrowUpRight size={13} />
                    </a>
                  ) : (
                    'Not broadcast'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="system-bottom">
        <div>
          <h3>Webhook inbox</h3>
          {data?.events.length ? (
            data.events.map((e) => (
              <div className="event-line" key={e.signature}>
                <span>{shortAddress(e.signature)}</span>
                <span>{e.processed_at ? e.result : 'Queued for verification'}</span>
              </div>
            ))
          ) : (
            <p className="muted">No webhook deliveries yet.</p>
          )}
        </div>
        <div>
          <h3>Balanced journal</h3>
          <p>Every finalized payment creates two immutable entries. Their sum is zero.</p>
          <div className="journal-total">
            <span>Sum of the latest entries</span>
            <strong>
              {data
                ? formatAmount(data.journal.reduce((sum, e) => sum + BigInt(e.delta), 0n))
                : '—'}{' '}
              USDC
            </strong>
          </div>
          <p className="muted">
            Observed wallet movements, not custodial account balances. External transfers are
            outside this journal.
          </p>
        </div>
      </div>
    </section>
  );
}
