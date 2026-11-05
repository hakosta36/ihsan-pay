import { handle } from '@/server/router';
export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ path: string[] }> };
export async function GET(req: Request, context: Context) {
  return handle(req, (await context.params).path.join('/'));
}
export async function POST(req: Request, context: Context) {
  return handle(req, (await context.params).path.join('/'));
}
