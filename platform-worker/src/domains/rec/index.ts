import type { Env } from '../../env';

export { RecDO } from './RecDO';

export function handleRec(_request: Request, _env: Env, _ctx: ExecutionContext): Response {
  // Slice 4: will port rec-worker logic here
  return new Response(JSON.stringify({ error: 'Rec domain not yet migrated' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  });
}
