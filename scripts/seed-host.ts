import { createClient } from '@supabase/supabase-js';
const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
};
const username = env('DEMO_HOST_USERNAME'),
  password = env('DEMO_HOST_PASSWORD');
if (!/^[a-z][a-z0-9_]{2,23}$/.test(username) || password.length < 12)
  throw new Error('Invalid host username or password (minimum 12 characters).');
const db = createClient(env('NEXT_PUBLIC_SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
});
const { data: existing, error: lookupError } = await db
  .from('profiles')
  .select('id')
  .eq('username', username)
  .maybeSingle();
if (lookupError) throw new Error('Run the SQL migration first.');
if (existing) {
  console.log('Host already exists. No changes made.');
  process.exit(0);
}
const { error } = await db.auth.admin.createUser({
  email: `${username}@users.ihsan-demo.invalid`,
  password,
  email_confirm: true,
  user_metadata: { username, display_name: 'Emir Akdağ' },
});
if (error) throw new Error('Host creation failed. Check Auth settings and the SQL migration.');
console.log('Host account created. Open the left phone and activate its Privy wallet once.');
