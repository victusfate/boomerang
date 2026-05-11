import type { Env } from '../../env';
import { corsHeaders, handlePreflight } from '../../cors';

export function handleRss(_request: Request, _env: Env, _ctx: ExecutionContext): Response {
  // Slice 1: will port rss-worker logic here
  return new Response(JSON.stringify({ error: 'RSS domain not yet migrated' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
  });
}

export { corsHeaders, handlePreflight };
