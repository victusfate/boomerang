import type { Env } from '../../env';

export { MetaDO } from './MetaDO';

export function handleMeta(_request: Request, _env: Env, _ctx: ExecutionContext): Response {
  // Slice 3: will port meta-worker logic here
  return new Response(JSON.stringify({ error: 'Meta domain not yet migrated' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function scheduledMeta(_env: Env): Promise<void> {
  // Slice 3: will trigger META_DO prune here
}
