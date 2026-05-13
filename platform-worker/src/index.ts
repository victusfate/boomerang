import type { Env } from './env';
import { handlePreflight, corsHeaders } from './cors';
import { handleRss } from './domains/rss/index';
import { handleSync } from './domains/sync/index';
import { handleMeta, scheduledMeta } from './domains/meta/index';
import { handleRec, scheduledRec } from './domains/rec/index';

export { MetaDO } from './domains/meta/MetaDO';
export { RecDO } from './domains/rec/RecDO';

function json(data: unknown, status = 200, extraHeaders?: Headers): Response {
  const headers = extraHeaders ?? new Headers();
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data), { status, headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const preflight = handlePreflight(request, env);
    if (preflight) return preflight;

    const url = new URL(request.url);
    const path = url.pathname;

    // ── Health ────────────────────────────────────────────────────────────────
    if (path === '/health') {
      return json({ ok: true, service: 'platform-worker' });
    }
    if (path === '/health/rss')  return json({ ok: true, domain: 'rss' });
    if (path === '/health/sync') return json({ ok: true, domain: 'sync' });
    if (path === '/health/meta') return json({ ok: true, domain: 'meta' });
    if (path === '/health/rec')  return json({ ok: true, domain: 'rec' });

    // ── RSS domain ────────────────────────────────────────────────────────────
    if (path === '/bundle' || path === '/og-image' || path === '/image') {
      return handleRss(request, env, ctx);
    }

    // ── Sync domain ───────────────────────────────────────────────────────────
    if (path.startsWith('/sync/') || path === '/sync') {
      return handleSync(request, env, ctx);
    }

    // ── Meta domain ───────────────────────────────────────────────────────────
    if (path === '/meta' || path.startsWith('/meta/') || path === '/ws') {
      return handleMeta(request, env, ctx);
    }

    // ── Rec domain ────────────────────────────────────────────────────────────
    if (path === '/interactions' || path.startsWith('/recommendations/') || path === '/rec/debug') {
      return handleRec(request, env, ctx);
    }

    const h = corsHeaders(request, env);
    return json({ error: 'Not Found' }, 404, h);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await scheduledMeta(env);
    scheduledRec(env, ctx);
  },
} satisfies ExportedHandler<Env>;
