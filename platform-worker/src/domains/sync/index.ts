import type { Env } from '../../env';

export function handleSync(_request: Request, _env: Env, _ctx: ExecutionContext): Response {
  // Slice 2: will port sync-worker logic here
  return new Response(JSON.stringify({ error: 'Sync domain not yet migrated' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  });
}
