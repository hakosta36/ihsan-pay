'use client';
import { useEffect, useRef, useState } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import {
  useWallets,
  useCreateWallet,
  useSignMessage,
  useSignTransaction,
  useExportWallet,
} from '@privy-io/react-auth/solana';
import bs58 from 'bs58';
import {
  ArrowDownLeft,
  ArrowLeft,
  Search,
  ArrowUpRight,
  CheckCheck,
  ChevronRight,
  Copy,
  FileText,
  LogOut,
  MessageCircle,
  Plus,
  Send,
  ShieldCheck,
  UserRound,
  Wallet,
  X,
} from 'lucide-react';
import { Dialog } from './dialog';
import { SessionProvider, useSession } from '@/client/session';
import { explorer, formatAmount, parseAmount, shortAddress } from '@/lib/money';
import type { Snapshot, Profile, Payment } from '@/lib/types';
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (str: string) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
export default function PhoneApp() {
  if (
    !process.env.NEXT_PUBLIC_PRIVY_APP_ID ||
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  )
    return (
      <div className="phone-loading">Configure Privy and Supabase to open the application.</div>
    );
  return (
    <SessionProvider>
      <Account />
    </SessionProvider>
  );
}
function Account() {
  const { client, session, api } = useSession();
  const { ready, authenticated, logout, user: privyUser } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { createWallet } = useCreateWallet();
  const { signMessage } = useSignMessage();
  const { signTransaction } = useSignTransaction();
  const { exportWallet } = useExportWallet();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [tab, setTab] = useState<'chat' | 'profile' | 'receipts'>('chat'),
    [contact, setContact] = useState<string>('');
  const [text, setText] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [payment, setPayment] = useState<{
      amount: string;
      key: string;
      id?: string;
      transaction?: string;
    } | null>(null),
    [receipt, setReceipt] = useState<Payment | null>(null);
  const [amount, setAmount] = useState('5'),
    [sending, setSending] = useState(false);
  const host =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('side') === 'host';
  const demoStarted = useRef(false),
    end = useRef<HTMLDivElement>(null),
    lastReconcile = useRef(0),
    fetching = useRef(false);
  const [walletSetup, setWalletSetup] = useState<
    'waiting' | 'creating' | 'created' | 'linking' | 'failed' | 'done'
  >('waiting');
  const [chatOpen, setChatOpen] = useState(false);
  const [chatSearch, setChatSearch] = useState('');
  const walletSetupRun = useRef<{ userId: string } | null>(null);
  const automaticSetupAttempt = useRef<string | null>(null);
  const failedDuringCreation = useRef(false);
  const currentSessionId = useRef(session?.user.id);
  currentSessionId.current = session?.user.id;
  const embeddedWallet = wallets.find((wallet) => wallet.standardWallet.name === 'Privy');
  const privyMatchesSession = Boolean(
    session &&
    privyUser?.linkedAccounts.some(
      (account) => account.type === 'custom_auth' && account.customUserId === session.user.id,
    ),
  );
  const faucetKey = useRef<string | null>(null);
  const contactRef = useRef(contact);
  contactRef.current = contact;
  async function load() {
    if (fetching.current) return;
    fetching.current = true;
    try {
      const data = await api('snapshot');
      setSnapshot(data);
      if (!contactRef.current) {
        const chosen = host
          ? data.contacts.at(-1)
          : data.contacts.find((p) => p.username === process.env.NEXT_PUBLIC_DEMO_HOST_USERNAME) ||
            data.contacts[0];
        if (chosen) setContact(chosen.id);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      fetching.current = false;
    }
  }
  useEffect(() => {
    if (!host || demoStarted.current) return;
    demoStarted.current = true;
    void api('auth/demo', {})
      .then(({ session }) => client.auth.setSession(session))
      .catch((e) => setError(e.message));
  }, [host]);
  useEffect(() => {
    if (!session) {
      setSnapshot(null);
      return;
    }
    void load();
    const timer = setInterval(() => void load(), 8000);
    const channel = client
      .channel(`messages:${session.user.id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        () => void load(),
      )
      .subscribe();
    return () => {
      clearInterval(timer);
      void client.removeChannel(channel);
    };
  }, [session?.user.id]);
  useEffect(() => {
    if (!snapshot?.payments.some((p) => p.status === 'submitted' || p.status === 'prepared'))
      return;
    if (Date.now() - lastReconcile.current < 12000) return;
    lastReconcile.current = Date.now();
    void api('payments/reconcile', {})
      .then(() => load())
      .catch(() => {});
  }, [snapshot]);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [
    snapshot?.messages.length,
    snapshot?.payments.map((p) => p.status).join(','),
    contact,
    chatOpen,
  ]);
  async function task(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function activateWallet() {
    const userId = session?.user.id;
    if (!userId || snapshot?.me.id !== userId || snapshot.me.wallet_address) return;
    if (walletSetupRun.current?.userId === userId) return;
    const run = { userId };
    let creating = false;
    walletSetupRun.current = run;
    setBusy(true);
    setError('');
    setNotice('');
    const stillCurrent = () =>
      currentSessionId.current === userId && walletSetupRun.current === run;
    try {
      if (!ready || !authenticated || !privyMatchesSession) {
        throw new Error(
          'Your secure wallet connection is not ready yet. Please retry in a moment.',
        );
      }
      if (!walletsReady) throw new Error('Your wallet is still loading. Please retry in a moment.');
      if (!embeddedWallet) {
        creating = true;
        setWalletSetup('creating');
        await createWallet();
        if (stillCurrent()) setWalletSetup('created');
        // The wallet hook supplies the newly created signer. The effect below then links it.
        return;
      }
      setWalletSetup('linking');
      const challenge = await api('wallet/challenge', {});
      if (!stillCurrent()) return;
      if (!challenge.bound) {
        const { signature } = await signMessage({
          wallet: embeddedWallet,
          message: new TextEncoder().encode(challenge.nonce),
        });
        if (!stillCurrent()) return;
        await api('wallet/bind', {
          address: embeddedWallet.address,
          nonce: challenge.nonce,
          signature: bs58.encode(signature),
        });
        if (!stillCurrent()) return;
      }
      setWalletSetup('done');
      await load();
    } catch (cause) {
      if (stillCurrent()) {
        failedDuringCreation.current = creating;
        setWalletSetup('failed');
        setError(
          cause instanceof Error ? cause.message : 'Wallet setup could not finish. Please retry.',
        );
      }
    } finally {
      if (walletSetupRun.current === run) {
        walletSetupRun.current = null;
        if (currentSessionId.current === userId) setBusy(false);
      }
    }
  }
  useEffect(() => {
    walletSetupRun.current = null;
    automaticSetupAttempt.current = null;
    failedDuringCreation.current = false;
    setWalletSetup('waiting');
    setBusy(false);
    setChatOpen(false);
    setChatSearch('');
  }, [session?.user.id]);
  useEffect(() => {
    if (
      !session ||
      snapshot?.me.id !== session.user.id ||
      snapshot.me.wallet_address ||
      !ready ||
      !authenticated ||
      !privyMatchesSession ||
      !walletsReady ||
      (walletSetup === 'failed' && !(failedDuringCreation.current && embeddedWallet)) ||
      walletSetup === 'done' ||
      walletSetupRun.current
    )
      return;
    const attempt = `${session.user.id}:${embeddedWallet?.address || 'create'}`;
    if (automaticSetupAttempt.current === attempt) return;
    
    const timer = setTimeout(
      () => {
        if (currentSessionId.current !== session.user.id || walletSetupRun.current) return;
        automaticSetupAttempt.current = attempt;
        void activateWallet();
      },
      embeddedWallet ? 100 : 1200,
    );
    return () => clearTimeout(timer);
  }, [
    session?.user.id,
    snapshot?.me.id,
    snapshot?.me.wallet_address,
    ready,
    authenticated,
    privyMatchesSession,
    walletsReady,
    embeddedWallet?.address,
    walletSetup,
  ]);
  useEffect(() => {
    if (
      !session ||
      snapshot?.me.id !== session.user.id ||
      snapshot.me.wallet_address ||
      (walletSetup !== 'waiting' && walletSetup !== 'created')
    )
      return;
    const timer = setTimeout(() => {
      if (currentSessionId.current !== session.user.id || walletSetupRun.current) return;
      setWalletSetup('failed');
      setError('Your wallet connection is taking longer than expected. Please retry setup.');
    }, 25000);
    return () => clearTimeout(timer);
  }, [session?.user.id, snapshot?.me.id, snapshot?.me.wallet_address, walletSetup]);
  async function fund() {
    await task(async () => {
      faucetKey.current ??= crypto.randomUUID();
      const result = await api('faucet', { key: faucetKey.current });
      setNotice(
        result.status === 'finalized'
          ? 'Test funding already received.'
          : 'Test funding submitted. Waiting for finality.',
      );
      await load();
    });
  }
  async function sendMessage() {
    const value = text.trim();
    if (!value || !contact) return;
    await task(async () => {
      await api('messages', { recipientId: contact, body: value, clientId: crypto.randomUUID() });
      setText('');
      await load();
    });
  }
  async function confirmPayment() {
    if (!payment || !snapshot) return;
    setSending(true);
    setError('');
    try {
      const wallet = wallets.find((w) => w.address === snapshot.me.wallet_address);
      if (!wallet)
        throw new Error(
          'Your account wallet is not available in this session. Activate it or sign in again.',
        );
      let intent = payment;
      if (!intent.transaction) {
        const prepared = await api('payments/prepare', {
          recipientId: contact,
          amount: intent.amount,
          key: intent.key,
        });
        if (prepared.status !== 'prepared' || !prepared.transaction) {
          setNotice(`Payment ${prepared.status}. Check your receipts.`);
          setPayment(null);
          await load();
          return;
        }
        intent = { ...intent, id: prepared.id, transaction: prepared.transaction };
        setPayment(intent);
      }
      const signed = await signTransaction({
        transaction: unb64(intent.transaction!),
        wallet,
        chain: 'solana:devnet',
      });
      const result = await api('payments/submit', {
        id: intent.id,
        transaction: b64(signed.signedTransaction),
      });
      setNotice(result.notice || 'Payment submitted. Waiting for finality.');
      setPayment(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  function accountLabel(userId: string | null, walletAddress: string): string {
    if (!snapshot) return 'Account';
    if (!userId && walletAddress === snapshot.faucetAddress) return 'Test faucet';
    const owner = [snapshot.me, ...snapshot.contacts].find(
      (profile) => profile.id === userId || profile.wallet_address === walletAddress,
    );
    return owner ? `@${owner.username}` : userId ? 'Registered user' : 'External account';
  }
  const selected = snapshot?.contacts.find((p) => p.id === contact);
  const walletActive = Boolean(snapshot?.me.wallet_address);
  const currentReceipt =
    (receipt && snapshot?.payments.find((p) => p.id === receipt.id)) || receipt;
  const feed =
    snapshot && selected
      ? [
          ...snapshot.messages
            .filter(
              (m) =>
                (m.sender_id === contact && m.recipient_id === snapshot.me.id) ||
                (m.sender_id === snapshot.me.id && m.recipient_id === contact),
            )
            .map((m) => ({ type: 'message' as const, time: m.created_at, item: m })),
          ...snapshot.payments
            .filter(
              (p) =>
                p.kind === 'transfer' &&
                ((p.sender_id === snapshot.me.id && p.recipient_id === contact) ||
                  (p.sender_id === contact && p.recipient_id === snapshot.me.id)),
            )
            .map((p) => ({ type: 'payment' as const, time: p.created_at, item: p })),
        ].sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
      : [];
  const query = chatSearch.trim().replace(/^@/, '').toLocaleLowerCase();
  const conversations = (snapshot?.contacts || [])
    .map((person) => {
      const messages = snapshot!.messages.filter(
        (message) =>
          (message.sender_id === person.id && message.recipient_id === snapshot!.me.id) ||
          (message.sender_id === snapshot!.me.id && message.recipient_id === person.id),
      );
      const lastMessage = messages.reduce<(typeof messages)[number] | undefined>(
        (latest, message) =>
          !latest || Date.parse(message.created_at) > Date.parse(latest.created_at)
            ? message
            : latest,
        undefined,
      );
      const transfers = snapshot!.payments.filter(
        (item) =>
          item.kind === 'transfer' &&
          ((item.sender_id === person.id && item.recipient_id === snapshot!.me.id) ||
            (item.sender_id === snapshot!.me.id && item.recipient_id === person.id)),
      );
      const lastTransfer = transfers.reduce<(typeof transfers)[number] | undefined>(
        (latest, item) =>
          !latest || Date.parse(item.created_at) > Date.parse(latest.created_at) ? item : latest,
        undefined,
      );
      const transferIsLatest =
        lastTransfer &&
        (!lastMessage || Date.parse(lastTransfer.created_at) > Date.parse(lastMessage.created_at));
      const preview = transferIsLatest
        ? `${lastTransfer.sender_id === snapshot!.me.id ? 'Payment to' : 'Payment from'} @${person.username}: ${formatAmount(lastTransfer.amount)} USDC`
        : lastMessage
          ? `${lastMessage.sender_id === snapshot!.me.id ? 'You: ' : ''}${lastMessage.body}`
          : 'Start a conversation';
      return {
        person,
        preview,
        lastActivity: transferIsLatest ? lastTransfer.created_at : lastMessage?.created_at || null,
      };
    })
    .filter(
      ({ person }) =>
        !query ||
        person.username.toLocaleLowerCase().includes(query) ||
        person.display_name.toLocaleLowerCase().includes(query),
    )
    .sort(
      (a, b) =>
        Date.parse(b.lastActivity || '1970-01-01') - Date.parse(a.lastActivity || '1970-01-01') ||
        a.person.username.localeCompare(b.person.username),
    );
  return (
    <div className="phone-app">
      <style>{PHONE_GOLD_STYLES}</style>
      <div className="phone-status">
        <strong>9:41</strong>
        <span>▰ ▰ ▰</span>
      </div>
      {!session ? (
        <>
          <header className="phone-brand">
            <span className="brand-mark">i</span>
            <strong>ihsan</strong>
            <span className="devnet-tag">Devnet</span>
          </header>
          <AuthForm host={host} error={error} onClear={() => setError('')} />
        </>
      ) : (
        <>
          <header className="phone-brand">
            <span className="brand-mark">i</span>
            <strong>ihsan</strong>
            <span className="devnet-tag">Test money</span>
          </header>
          {(error || notice) && (
            <div
              className={error ? 'phone-alert error' : 'phone-alert'}
              role={error ? 'alert' : 'status'}
            >
              {error || notice}
              <button
                aria-label="Dismiss notification"
                onClick={() => {
                  setError('');
                  setNotice('');
                }}
              >
                <X size={13} />
              </button>
            </div>
          )}
          {!snapshot ? (
            <div className="phone-loading">Loading your account…</div>
          ) : (
            <>
              {!walletActive && (
                <div className="wallet-activation">
                  <ShieldCheck size={19} />
                  <div>
                    <strong>
                      {walletSetup === 'failed'
                        ? 'Finish setting up your wallet'
                        : 'Preparing your account…'}
                    </strong>
                    <p role="status" aria-live="polite">
                      {walletSetup === 'failed'
                        ? 'Your account is ready. Retry to connect your personal wallet.'
                        : walletSetup === 'linking'
                          ? 'Confirm the wallet ownership request if prompted.'
                          : walletSetup === 'creating'
                            ? 'Creating your personal Solana wallet…'
                            : walletSetup === 'done'
                              ? 'Finishing your account setup…'
                              : 'Connecting your secure wallet…'}
                    </p>
                    {walletSetup === 'failed' && (
                      <button onClick={() => void activateWallet()} disabled={busy}>
                        {busy ? 'Connecting…' : 'Retry wallet setup'}
                      </button>
                    )}
                  </div>
                </div>
              )}
              {tab === 'chat' &&
                (!chatOpen ? (
                  <section className="chat-home" aria-label="Conversations">
                    <div className="chat-home-heading">
                      <h2>Chats</h2>
                      <span>{snapshot.contacts.length} contacts</span>
                    </div>
                    <label className="chat-search">
                      <Search size={17} aria-hidden="true" />
                      <input
                        type="search"
                        aria-label="Search by name or username"
                        placeholder="Search name or @username"
                        value={chatSearch}
                        onChange={(event) => setChatSearch(event.target.value)}
                      />
                    </label>
                    <div className="chat-list">
                      {conversations.length ? (
                        conversations.map(({ person, preview, lastActivity }) => (
                          <button
                            className="chat-list-row"
                            key={person.id}
                            aria-label={`Open conversation with @${person.username}`}
                            onClick={() => {
                              setContact(person.id);
                              setText('');
                              setChatOpen(true);
                              setChatSearch('');
                            }}
                          >
                            <span className="avatar">
                              {person.display_name[0]?.toUpperCase() || '?'}
                            </span>
                            <span className="chat-list-copy">
                              <span className="chat-list-top">
                                <strong>{person.display_name}</strong>
                                {lastActivity && (
                                  <time>
                                    {new Date(lastActivity).toDateString() ===
                                    new Date().toDateString()
                                      ? new Date(lastActivity).toLocaleTimeString([], {
                                          hour: '2-digit',
                                          minute: '2-digit',
                                        })
                                      : new Date(lastActivity).toLocaleDateString([], {
                                          month: 'short',
                                          day: 'numeric',
                                        })}
                                  </time>
                                )}
                              </span>
                              <span className="chat-list-username">@{person.username}</span>
                              <span className="chat-list-preview">{preview}</span>
                            </span>
                          </button>
                        ))
                      ) : (
                        <div className="chat-empty">
                          <Search size={25} />
                          <p>{query ? 'No matching accounts.' : 'No contacts yet.'}</p>
                          <small>
                            {query
                              ? 'Try a different name or username.'
                              : 'Registered accounts will appear here.'}
                          </small>
                        </div>
                      )}
                    </div>
                  </section>
                ) : (
                  <>
                    <div className="chat-toolbar">
                      <button
                        className="chat-back"
                        aria-label="Back to chats"
                        onClick={() => setChatOpen(false)}
                      >
                        <ArrowLeft size={20} />
                      </button>
                      <div className="avatar">
                        {selected?.display_name[0]?.toUpperCase() || '?'}
                      </div>
                      <div className="chat-person">
                        <strong>{selected?.display_name || 'Conversation'}</strong>
                        <small>{selected ? `@${selected.username}` : ''}</small>
                      </div>
                      <ShieldCheck size={18} className="muted" />
                    </div>
                    <div className="conversation">
                      <div className="conversation-date">Today</div>
                      {!feed.length && (
                        <div className="chat-empty">
                          <MessageCircle size={25} />
                          <p>
                            {selected
                              ? `Say hello to ${selected.display_name.split(' ')[0]}.`
                              : 'Your contacts will appear here.'}
                          </p>
                          <small>Send a message, or make a payment.</small>
                        </div>
                      )}
                      {feed.map((entry) =>
                        entry.type === 'message' ? (
                          <div
                            key={entry.item.id}
                            className={`bubble ${entry.item.sender_id === snapshot.me.id ? 'outgoing' : ''}`}
                          >
                            <p>{entry.item.body}</p>
                            <time>
                              {new Date(entry.time).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                              {entry.item.sender_id === snapshot.me.id && <CheckCheck size={13} />}
                            </time>
                          </div>
                        ) : (
                          <button
                            key={entry.item.id}
                            className={`payment-bubble ${entry.item.sender_id === snapshot.me.id ? 'outgoing' : ''}`}
                            onClick={() => setReceipt(entry.item)}
                          >
                            <span className="payment-icon">
                              {entry.item.sender_id === snapshot.me.id ? (
                                <ArrowUpRight size={19} />
                              ) : (
                                <ArrowDownLeft size={19} />
                              )}
                            </span>
                            <small>
                              {entry.item.sender_id === snapshot.me.id
                                ? 'You sent'
                                : 'You received'}
                            </small>
                            <strong>
                              {formatAmount(entry.item.amount)} <span>USDC</span>
                            </strong>
                            <span className={`status ${entry.item.status}`}>
                              {entry.item.status === 'finalized' ? 'Completed' : entry.item.status}
                            </span>
                            <span className="view-receipt">
                              View receipt <ChevronRight size={13} />
                            </span>
                          </button>
                        ),
                      )}
                      <div ref={end} />
                    </div>
                    <div className="composer">
                      <button
                        aria-label="Send money"
                        className="money-button"
                        disabled={!selected?.wallet_address || !walletActive || busy}
                        onClick={() => {
                          setError('');
                          setPayment({ amount, key: crypto.randomUUID() });
                        }}
                      >
                        <Plus size={21} />
                      </button>
                      <label className="sr-only" htmlFor="message">
                        Message
                      </label>
                      <input
                        id="message"
                        placeholder="Message…"
                        maxLength={2000}
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            void sendMessage();
                          }
                        }}
                      />
                      <button
                        aria-label="Send message"
                        className="send-message"
                        disabled={!text.trim() || !contact || busy}
                        onClick={() => void sendMessage()}
                      >
                        <Send size={18} />
                      </button>
                    </div>
                  </>
                ))}
              {tab === 'profile' && (
                <div className="profile-content">
                  <div className="profile-person">
                    <div className="avatar large">{snapshot.me.display_name[0].toUpperCase()}</div>
                    <h2>{snapshot.me.display_name}</h2>
                    <p>@{snapshot.me.username}</p>
                  </div>
                  <div className="balance-card">
                    <span>Available test balance</span>
                    <strong>
                      {formatAmount(snapshot.balance)} <small>USDC</small>
                    </strong>
                    <button disabled={busy || !walletActive} onClick={() => void fund()}>
                      <Plus size={16} />
                      {busy ? 'Processing…' : 'Add 3 test USDC'}
                    </button>
                    <p>One grant per 24 hours. No real money.</p>
                  </div>
                  <div className="profile-row">
                    <Wallet size={19} />
                    <div>
                      <strong>Solana wallet</strong>
                      <small>{shortAddress(snapshot.me.wallet_address || '')}</small>
                    </div>
                    <button
                      aria-label="Copy wallet address"
                      disabled={!walletActive}
                      onClick={() =>
                        void task(async () => {
                          await navigator.clipboard.writeText(snapshot.me.wallet_address!);
                          setNotice('Wallet address copied.');
                        })
                      }
                    >
                      <Copy size={16} />
                    </button>
                  </div>
                  <button
                    className="profile-row"
                    disabled={!walletActive || busy}
                    onClick={() =>
                      void task(async () => {
                        await exportWallet({ address: snapshot.me.wallet_address! });
                      })
                    }
                  >
                    <ShieldCheck size={19} />
                    <div>
                      <strong>Export your wallet</strong>
                      <small>Shown securely by Privy</small>
                    </div>
                    <ChevronRight size={16} />
                  </button>
                  <button
                    className="profile-row"
                    onClick={() =>
                      void task(async () => {
                        await logout();
                        await client.auth.signOut();
                      })
                    }
                  >
                    <LogOut size={19} />
                    <strong>Sign out</strong>
                  </button>
                  <p className="profile-footnote">
                    Network fees are sponsored. Your test-USDC balance stays on Solana Devnet.
                  </p>
                </div>
              )}
              {tab === 'receipts' && (
                <div className="receipts-content">
                  <h2>Your activity</h2>
                  <p className="muted">Payments and test funding</p>
                  {!snapshot.payments.length && (
                    <div className="chat-empty">
                      <FileText size={25} />
                      <p>No payments yet.</p>
                      <small>Add test USDC from your profile to begin.</small>
                    </div>
                  )}
                  {snapshot.payments.map((p) => (
                    <button className="receipt-row" key={p.id} onClick={() => setReceipt(p)}>
                      <span
                        className={`receipt-icon ${p.recipient_id === snapshot.me.id ? 'incoming' : ''}`}
                      >
                        {p.recipient_id === snapshot.me.id ? (
                          <ArrowDownLeft size={18} />
                        ) : (
                          <ArrowUpRight size={18} />
                        )}
                      </span>
                      <div>
                        <strong>
                          {p.kind === 'faucet'
                            ? 'Test funding'
                            : p.sender_id === snapshot.me.id
                              ? `Sent to ${accountLabel(p.recipient_id, p.destination_wallet)}`
                              : `Received from ${accountLabel(p.sender_id, p.source_wallet)}`}
                        </strong>
                        <small>
                          {new Date(p.created_at).toLocaleDateString()} · {p.status}
                        </small>
                      </div>
                      <strong>
                        {p.recipient_id === snapshot.me.id ? '+' : '−'}
                        {formatAmount(p.amount)}
                        <small>USDC</small>
                      </strong>
                    </button>
                  ))}
                </div>
              )}
              <nav className="phone-nav" aria-label="Account">
                <button
                  aria-current={tab === 'chat' ? 'page' : undefined}
                  onClick={() => {
                    setTab('chat');
                    setChatOpen(false);
                  }}
                >
                  <MessageCircle size={21} />
                  <span>Chat</span>
                </button>
                <button
                  aria-current={tab === 'receipts' ? 'page' : undefined}
                  onClick={() => setTab('receipts')}
                >
                  <FileText size={21} />
                  <span>Activity</span>
                </button>
                <button
                  aria-current={tab === 'profile' ? 'page' : undefined}
                  onClick={() => setTab('profile')}
                >
                  <UserRound size={21} />
                  <span>Profile</span>
                </button>
              </nav>
            </>
          )}
        </>
      )}
      {payment && (
        <Dialog onClose={() => setPayment(null)} locked={sending}>
          <section
            className="payment-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Confirm payment"
          >
            <button
              className="sheet-close"
              aria-label="Close payment"
              disabled={sending}
              onClick={() => setPayment(null)}
            >
              <X size={20} />
            </button>
            <span className="sheet-symbol">
              <ArrowUpRight size={28} />
            </span>
            <h2>Send to @{selected?.username}</h2>
            <p>@{selected?.username}</p>
            <label className="amount-label">
              Amount in test USDC
              <input
                autoFocus
                inputMode="decimal"
                value={payment.amount}
                disabled={Boolean(payment.transaction) || sending}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setPayment({ ...payment, amount: e.target.value });
                }}
              />
            </label>
            <div className="confirmation-line">
              <span>Available</span>
              <strong>{snapshot ? formatAmount(snapshot.balance) : '0'} USDC</strong>
            </div>
            <div className="confirmation-line">
              <span>Network fee</span>
              <strong>Paid by the application</strong>
            </div>
            <p className="consent-note">
              You will approve this transfer with your wallet. Finalized payments cannot be
              reversed.
            </p>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button
              className="primary-button"
              disabled={sending}
              onClick={() => {
                try {
                  parseAmount(payment.amount);
                  void confirmPayment();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              {sending
                ? 'Awaiting approval…'
                : payment.transaction
                  ? 'Retry the same payment'
                  : 'Confirm payment'}
            </button>
          </section>
        </Dialog>
      )}
      {currentReceipt && (
        <Dialog onClose={() => setReceipt(null)}>
          <section
            className="payment-sheet receipt-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Payment receipt"
          >
            <button
              className="sheet-close"
              aria-label="Close receipt"
              onClick={() => setReceipt(null)}
            >
              <X size={20} />
            </button>
            <span className="sheet-symbol">
              <FileText size={25} />
            </span>
            <h2>{formatAmount(currentReceipt.amount)} USDC</h2>
            <span className={`status ${currentReceipt.status}`}>{currentReceipt.status}</span>
            <dl>
              <dt>From</dt>
              <dd>{accountLabel(currentReceipt.sender_id, currentReceipt.source_wallet)}</dd>
              <dt>To</dt>
              <dd>
                {accountLabel(currentReceipt.recipient_id, currentReceipt.destination_wallet)}
              </dd>
              <dt>Created</dt>
              <dd>{new Date(currentReceipt.created_at).toLocaleString()}</dd>
              <dt>Finalized</dt>
              <dd>
                {currentReceipt.finalized_at
                  ? new Date(currentReceipt.finalized_at).toLocaleString()
                  : 'Awaiting finality'}
              </dd>
              <dt>Slot</dt>
              <dd>{currentReceipt.slot ?? '—'}</dd>
              <dt>Transaction signature</dt>
              <dd>{currentReceipt.signature || 'Not broadcast yet'}</dd>
            </dl>
            {currentReceipt.signature && (
              <a
                className="primary-button"
                href={explorer(currentReceipt.signature)}
                target="_blank"
                rel="noreferrer"
              >
                View on Solana Explorer <ArrowUpRight size={16} />
              </a>
            )}
          </section>
        </Dialog>
      )}
    </div>
  );
}
function AuthForm({ host, error, onClear }: { host: boolean; error: string; onClear: () => void }) {
  const { client, api } = useSession();
  const [register, setRegister] = useState(true),
    [username, setUsername] = useState(''),
    [name, setName] = useState(''),
    [password, setPassword] = useState(''),
    [localError, setLocalError] = useState(''),
    [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setLocalError('');
    onClear();
    try {
      const result = await api(`auth/${register ? 'register' : 'login'}`, {
        username: username.toLowerCase(),
        password,
        ...(register ? { displayName: name } : {}),
      });
      const { error } = await client.auth.setSession(result.session);
      if (error) throw error;
    } catch (e) {
      setLocalError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-content">
      <span className="auth-symbol">
        <MessageCircle size={30} />
      </span>
      <h1>
        A little closer.
        <br />
        Even with money.
      </h1>
      <p>Create your account, say hello and send your first test payment.</p>
      <div className="auth-switch">
        <button aria-pressed={register} onClick={() => setRegister(true)}>
          Create account
        </button>
        <button aria-pressed={!register} onClick={() => setRegister(false)}>
          Sign in
        </button>
      </div>
      <form onSubmit={submit}>
        {register && (
          <label>
            Your name
            <input
              required
              maxLength={60}
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Alex Morgan"
            />
          </label>
        )}
        <label>
          Username
          <input
            required
            pattern="[a-z][a-z0-9_]{2,23}"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase())}
            placeholder="alex"
          />
        </label>
        <label>
          Password
          <input
            required
            type="password"
            minLength={12}
            maxLength={128}
            autoComplete={register ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 12 characters"
          />
        </label>
        {(localError || error) && (
          <p className="error" role="alert">
            {localError || error}
          </p>
        )}
        <button className="primary-button" disabled={busy}>
          {busy ? 'Connecting…' : register ? 'Create your account' : 'Sign in'}
        </button>
      </form>
      <p className="auth-disclaimer">
        A devnet-only prototype. Use a unique test password. Do not enter real payment information.
      </p>
      {host && (
        <p className="error">
          Host account not available? Configure ENABLE_PUBLIC_DEMO_HOST and run the seed script.
        </p>
      )}
    </div>
  );
}


const PHONE_GOLD_STYLES = `
/* Scoped to the phone document: the surrounding lab and system view are unchanged. */
.phone-app {
  --ink: #302a20;
  --green: #89641a;
  --green-dark: #67490f;
  --muted: #817563;
  --line: #e8dfcc;
  --red: #a23732;
  color: var(--ink);
  background: #fffcf6;
}
.phone-app :is(button, a, input, select):focus-visible {
  outline-color: #b38b36;
}
.phone-app .phone-status { color: #493d28; background: #fffcf6; }
.phone-app .phone-brand {
  background: #fffcf6;
  border-bottom-color: #e8dfcc;
}
.phone-app .brand-mark {
  background: linear-gradient(145deg, #b9923e, #86601a);
  color: #fffaf0;
}
.phone-app .devnet-tag {
  color: #806426;
  background: #faf3e2;
  border-color: #e8d9b3;
}
.phone-app .phone-loading { background: #fffcf6; color: #817563; }
.phone-app .auth-symbol {
  background: #f5ecd7;
  border: 1px solid #eadbb5;
  color: #946e22;
}
.phone-app .auth-content > p { color: #817563; }
.phone-app .auth-switch { border-bottom-color: #e8dfcc; }
.phone-app .auth-switch button { color: #897c67; }
.phone-app .auth-switch button[aria-pressed='true'] {
  color: #795512;
  border-color: #a7802c;
}
.phone-app .auth-content input {
  background: #fffefa;
  color: #302a20;
  border-color: #e3d8bf;
}
.phone-app .auth-content input::placeholder { color: #a19580; }
.phone-app .primary-button {
  color: #fffdf6;
  background: linear-gradient(110deg, #967025, #795414);
  box-shadow: inset 0 1px 0 #ffffff20;
}
.phone-app .primary-button:hover {
  background: linear-gradient(110deg, #86601c, #68460f);
}
.phone-app .phone-alert {
  color: #70531b;
  background: #f5ecd7;
}
.phone-app .phone-alert.error { color: #a23732; background: #fff0ec; }
.phone-app .wallet-activation {
  color: #805d19;
  background: #f7f0df;
  border-bottom-color: #e8dcbf;
}
.phone-app .wallet-activation p { color: #8a7959; }
.phone-app .wallet-activation button { color: #795512; }
.phone-app .chat-toolbar {
  background: #fffcf6;
  border-bottom-color: #e8dfcc;
}
.phone-app .avatar {
  color: #8a6521;
  background: #f3e7cc;
  border: 1px solid #e8d6ac;
}
.phone-app .chat-toolbar small,
.phone-app .profile-person p { color: #8a7b64; }
.phone-app .conversation {
  background-color: #f6f1e7;
  background-image: radial-gradient(#a88a4d14 .65px, transparent .65px);
  background-size: 13px 13px;
}
.phone-app .conversation-date { color: #9a8a6d; }
.phone-app .chat-empty { color: #af9a70; }
.phone-app .chat-empty p { color: #887453; }
.phone-app .bubble {
  color: #3a3020;
  background: #fffdfa;
  box-shadow: 0 1px 1px #63481c0b;
}
.phone-app .bubble.outgoing { background: #eadbb5; }
.phone-app .bubble time { color: #93805a; }
.phone-app .payment-bubble {
  color: #3a3020;
  background: #fffdf7;
  border-color: #e4d7b9;
}
.phone-app .payment-bubble.outgoing {
  background: #f1e5c7;
  border-color: #ddc795;
}
.phone-app .payment-bubble > small { color: #94773c; }
.phone-app .payment-icon { color: #987125; }
.phone-app .view-receipt { color: #8a6828; border-top-color: #e0cfaa; }
.phone-app .status { color: #89651f; background: #f3e6c5; }
.phone-app .status.finalized { color: #456344; background: #edf1e5; }
.phone-app .status.failed,
.phone-app .status.expired { color: #a23732; background: #fbece9; }
.phone-app .status.draft { color: #897c67; background: #efeae0; }
.phone-app .composer {
  background: #fffcf5;
  border-top-color: #e8dfcc;
}
.phone-app .composer input {
  background: #fffefa;
  color: #302a20;
  border-color: #e4d9bf;
}
.phone-app .composer input::placeholder { color: #a2947b; }
.phone-app .money-button { color: #8b651c; background: #f1e7d1; }
.phone-app .send-message {
  color: #fffdf6;
  background: linear-gradient(135deg, #aa8433, #86601a);
}
.phone-app .phone-nav {
  background: #fffcf6;
  border-top-color: #e8dfcc;
}
.phone-app .phone-nav button { color: #a29680; }
.phone-app .phone-nav button[aria-current='page'] { color: #8c6419; }
.phone-app .balance-card {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  background: linear-gradient(125deg, #493b25, #2e271c);
  border: 1px solid #b38e42;
  box-shadow: inset 0 1px 0 #ddbc6c30;
}
.phone-app .balance-card::before,
.phone-app .balance-card::after {
  content: '';
  position: absolute;
  pointer-events: none;
  width: 110px;
  height: 110px;
  right: -21px;
  top: -22px;
  border: 1px solid #d9b65b30;
  z-index: -1;
}
.phone-app .balance-card::after { transform: rotate(45deg); }
.phone-app .balance-card > span { color: #d5c298; }
.phone-app .balance-card > strong { color: #fff8e8; }
.phone-app .balance-card > strong > small { color: #d8bd7c; }
.phone-app .balance-card > button {
  color: #493518;
  background: linear-gradient(105deg, #e6ce8c, #c5a052);
  border: 1px solid #ebd79f;
}
.phone-app .balance-card > p { color: #c0ac82; }
.phone-app .profile-row { border-bottom-color: #e8dfcc; }
.phone-app .profile-row > svg { color: #95702a; }
.phone-app .profile-footnote { color: #9a8a6d; }
.phone-app .receipt-icon { color: #94763c; background: #f1e9d9; }
.phone-app .receipt-icon.incoming { color: #87631e; background: #f2e6c9; }
.phone-app .receipt-row { border-bottom-color: #e8dfcc; }
.phone-app .receipt-row > div > strong { overflow-wrap: anywhere; }
.phone-app .sheet-backdrop { background: #2c241975; }
.phone-app .payment-sheet {
  color: #302a20;
  background: #fffdf7;
  box-shadow: 0 -8px 40px #35281c20;
}
.phone-app .sheet-close { color: #826526; background: #f4ecda; }
.phone-app .sheet-symbol {
  color: #946c1d;
  background: #f3e8cb;
  border: 1px solid #e8d6aa;
}
.phone-app .payment-sheet h2 { overflow-wrap: anywhere; }
.phone-app .confirmation-line { border-bottom-color: #eee5d4; }
.phone-app .receipt-sheet dd { color: #49381f; }

.phone-app {
  background-color: #fffaf0;
  background-image: radial-gradient(ellipse at 6% 0%, #e3bd6550, transparent 50%), radial-gradient(ellipse at 100% 100%, #d5ad5140, transparent 52%);
  box-shadow: inset 0 0 0 2px #c69c43, inset 0 0 0 5px #fff5d8;
}
.phone-app .phone-brand {
  position: relative;
  background: linear-gradient(105deg, #efd892, #fff2c4 37%, #d1aa54 78%, #efdcaa);
  border-bottom: 1px solid #b28b37;
  color: #49320e;
  box-shadow: inset 0 1px 0 #fff9e3, 0 2px 7px #8b621a12;
}
.phone-app .phone-status { background: #ecd28d; color: #4d3819; }
.phone-app .devnet-tag { background: #fff7ddaa; color: #765315; border-color: #b8934890; }
.phone-app .auth-content {
  background-image: linear-gradient(#fffaf0de, #fffaf0ed), url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='96' height='96' viewBox='0 0 96 96'%3E%3Cg fill='none' stroke='%23b38934' stroke-width='1'%3E%3Cpath d='M48 4 61 35 92 48 61 61 48 92 35 61 4 48 35 35Z'/%3E%3Cpath d='M20 20H76V76H20Z'/%3E%3Cpath d='M0 0 20 20M96 0 76 20M0 96 20 76M96 96 76 76'/%3E%3C/g%3E%3C/svg%3E");
}
.phone-app .auth-symbol { background: linear-gradient(135deg, #f5df9d, #c89f47); color: #684714; border-color: #b68a30; box-shadow: inset 0 1px 0 #fff5cd; }
.phone-app .conversation {
  background-color: #f8f0dd;
  background-image: linear-gradient(#fcf7ead9, #fcf7eae8), url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='96' height='96' viewBox='0 0 96 96'%3E%3Cg fill='none' stroke='%23a67c26' stroke-width='1'%3E%3Cpath d='M48 4 61 35 92 48 61 61 48 92 35 61 4 48 35 35Z'/%3E%3Cpath d='M20 20H76V76H20Z'/%3E%3C/g%3E%3C/svg%3E");
  background-size: auto, 96px 96px;
}
.phone-app .bubble.outgoing { background: linear-gradient(115deg, #f0dfad, #e8cc86); border: 1px solid #d5b36a; }
.phone-app .payment-bubble.outgoing { background: linear-gradient(120deg, #faedc6, #e7cc88); border-color: #c5a050; box-shadow: inset 0 1px 0 #fff9e8; }
.phone-app .balance-card { background: linear-gradient(120deg, #65491d, #372a16 58%, #715220); border: 1px solid #ccaa59; box-shadow: inset 0 0 0 3px #e3bd6120, inset 0 0 0 5px #e3bd6112; }
.phone-app .balance-card::before, .phone-app .balance-card::after { border-color: #e9c56b55; }
.phone-app .primary-button { background: linear-gradient(110deg, #ad812c, #825a16 62%, #a67c2b); border: 1px solid #a67f30; }
.phone-app .phone-nav { background: linear-gradient(0deg, #f1dfa9, #fff9e8 66%); border-top-color: #d4b977; }
.phone-app .phone-nav button[aria-current='page'] { color: #76500e; }
.phone-app .phone-nav button[aria-current='page'] svg { filter: drop-shadow(0 1px 0 #fff7dc); }
.phone-app .payment-sheet { background: linear-gradient(150deg, #fffcf4, #fff7e2); border-top: 1px solid #ceab59; }
.phone-app .chat-home { display:flex;flex-direction:column;flex:1;min-height:0;background:#fffaf1; }
.phone-app .chat-home-heading { display:flex;align-items:center;justify-content:space-between;padding:20px 20px 14px; }
.phone-app .chat-home-heading h2 { margin:0;font-size:24px;font-weight:600;letter-spacing:-.7px;color:#533b15; }
.phone-app .chat-home-heading > span { font-size:10px;color:#9c8456; }
.phone-app .chat-search { display:flex;align-items:center;gap:9px;margin:0 16px 14px;padding:0 12px;min-height:43px;border:1px solid #dfc890;border-radius:11px;background:#f4ead2;flex-shrink:0;color:#96733a; }
.phone-app .chat-search input { border:0;background:transparent;outline:none;font-size:16px;color:#49381b;width:100%;min-width:0;height:43px; }
.phone-app .chat-search input::placeholder { font-size:11px;color:#9e8a62; }
.phone-app .chat-search:focus-within { outline:2px solid #c9a44e;outline-offset:2px; }
.phone-app .chat-list { flex:1;min-height:0;overflow-y:auto; }
.phone-app .chat-list-row { width:100%;display:flex;align-items:center;gap:12px;padding:14px 19px;text-align:left;background:transparent;border-bottom:1px solid #eee2c7;min-height:83px; }
.phone-app .chat-list-row:hover { background:#f7edd5; }
.phone-app .chat-list-row .avatar { width:45px;height:45px;font-size:18px;background:linear-gradient(140deg,#f0dc9f,#d9ba6c);border:1px solid #cba756;color:#735016; }
.phone-app .chat-list-copy { display:flex;flex-direction:column;flex:1;min-width:0;gap:4px; }
.phone-app .chat-list-top { display:flex;align-items:center;gap:8px;justify-content:space-between; }
.phone-app .chat-list-top strong { font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#4d391a; }
.phone-app .chat-list-top time { font-size:9px;color:#a38b5d;flex-shrink:0; }
.phone-app .chat-list-username { font-size:9px;color:#9b7b3e; }
.phone-app .chat-list-preview { font-size:11px;color:#8b806b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.5; }
.phone-app .chat-back { width:28px;min-height:44px;display:flex;align-items:center;justify-content:center;background:transparent;color:#8a6420;flex-shrink:0;padding:0; }
.phone-app .chat-toolbar { gap:9px;padding:10px 16px 10px 9px; }
.phone-app .chat-toolbar > .avatar { flex:0 0 37px;min-width:37px; }
.phone-app .chat-toolbar .chat-person { flex:1;min-width:0; }
.phone-app .chat-person > strong { font-size:12px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
`;
