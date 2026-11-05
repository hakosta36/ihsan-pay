import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { required } from './config';
export function db() {
  return createClient(required('NEXT_PUBLIC_SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
export function publicAuth() {
  return createClient(
    required('NEXT_PUBLIC_SUPABASE_URL'),
    required('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
export function check<T>(result: { data: T; error: { message: string; code?: string } | null }): T {
  if (result.error)
    throw new Error(`Database operation failed (${result.error.code || 'unknown'})`);
  return result.data;
}
