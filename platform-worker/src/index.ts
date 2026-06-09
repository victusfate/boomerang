import type { Env } from './env';
import { handlePreflight, corsHeaders } from './cors';
import { handleRss } from './domains/rss/index';
import { handleSync } from './domains/sync/index';
import { handleMeta, scheduledMeta } from './domains/meta/index';
import { handleRec, scheduledRec } from './domains/rec/index';

export { MetaDO } from './domains/meta/MetaDO';
export { RecDO } from './domains/rec/index';

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
      return json({ ok: true, service: 'platform-worker' }, 200, corsHeaders(request, env));
    }
    if (path === '/health/rss')  return json({ ok: true, domain: 'rss' }, 200, corsHeaders(request, env));
    if (path === '/health/sync') return json({ ok: true, domain: 'sync' }, 200, corsHeaders(request, env));
    if (path === '/health/meta') return json({ ok: true, domain: 'meta' }, 200, corsHeaders(request, env));
    if (path === '/health/rec')  return json({ ok: true, domain: 'rec' }, 200, corsHeaders(request, env));

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
    if (path === '/interactions' || path.startsWith('/recommendations/') || path === '/rec/debug' || path === '/rec/articles') {
      try {
        return await handleRec(request, env, ctx);
      } catch (err) {
        console.error('[rec] handler crash:', err);
        const h = corsHeaders(request, env);
        h.set('Content-Type', 'application/json; charset=utf-8');
        return new Response(
          JSON.stringify({ ok: false, error: 'rec_handler_crash', message: 'Rec domain threw an unexpected error.' }),
          { status: 500, headers: h },
        );
      }
    }

    const h = corsHeaders(request, env);
    return json({ error: 'Not Found' }, 404, h);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await scheduledMeta(env);
    await scheduledRec(env, ctx);
  },
} satisfies ExportedHandler<Env>;
