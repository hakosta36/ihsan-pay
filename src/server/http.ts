import 'server-only';
import { NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ZodError } from 'zod';
import { db, check } from './db';
import { required } from './config';
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function body(req: Request) {
  const text = await req.text();
  if (Buffer.byteLength(text) > 12_000) throw new HttpError(413, 'Request is too large.');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}
export function sameSecret(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function originGuard(req: Request) {
  const origin = req.headers.get('origin');
  const allowed = required('ALLOWED_ORIGINS')
    .split(',')
    .map((x) => x.trim());
  if (!origin || !allowed.includes(origin))
    throw new HttpError(403, 'Request origin is not allowed.');
}
export async function limit(req: Request, scope: string, count = 30, seconds = 60) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  const key = createHash('sha256')
    .update(required('RATE_LIMIT_SALT') + scope + ip)
    .digest('hex');
  const allowed = check(
    await db().rpc('take_rate_limit', { p_key: key, p_limit: count, p_seconds: seconds }),
  );
  if (!allowed) throw new HttpError(429, 'Too many requests. Please wait and try again.');
}
export async function route(fn: () => Promise<unknown>) {
  try {
    return NextResponse.json(await fn(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status =
      error instanceof HttpError ? error.status : error instanceof ZodError ? 400 : 500;
    const message =
      error instanceof HttpError
        ? error.message
        : error instanceof ZodError
          ? 'Check the entered information.'
          : 'The request could not be completed. Check server configuration or try again.';
    
    if (status === 500)
      console.error('Request failed:', error instanceof Error ? error.name : 'UnknownError');
    return NextResponse.json(
      { error: message },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
