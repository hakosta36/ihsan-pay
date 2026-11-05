export type Profile = {
  id: string;
  username: string;
  display_name: string;
  wallet_address: string | null;
  created_at: string;
};
export type Payment = {
  id: string;
  sender_id: string | null;
  recipient_id: string;
  amount: string;
  kind: 'transfer' | 'faucet';
  status: 'draft' | 'prepared' | 'submitted' | 'finalized' | 'failed' | 'expired';
  signature: string | null;
  source_wallet: string;
  destination_wallet: string;
  created_at: string;
  finalized_at: string | null;
  slot: number | null;
  error_code: string | null;
};
export type Message = {
  id: string;
  sender_id: string;
  recipient_id: string;
  body: string;
  created_at: string;
  client_id: string;
};
export type Snapshot = {
  me: Profile;
  contacts: Profile[];
  payments: Payment[];
  messages: Message[];
  balance: string;
  balanceUpdatedAt: string;
  faucetAddress: string;
  sponsorAddress: string;
};
export type Intent = Payment & {
  unsigned_transaction: string | null;
  signed_transaction: string | null;
  last_valid_block_height: number | null;
};
