import 'server-only';
import { db, check } from './db';
import { HttpError } from './http';
import type { Profile } from '@/lib/types';
export const usernameEmail = (username: string) =>
  `${username.toLowerCase()}@users.ihsan-demo.invalid`;
export async function authenticate(req: Request): Promise<Profile> {
  const token = req.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
  if (!token) throw new HttpError(401, 'Sign in to continue.');
  const { data, error } = await db().auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, 'Your session has expired. Sign in again.');
  const profile = check(await db().from('profiles').select('*').eq('id', data.user.id).single());
  if (!profile) throw new HttpError(401, 'Account is not ready.');
  return profile as Profile;
}
