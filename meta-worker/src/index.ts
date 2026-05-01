import { MetaDO } from './MetaDO';
export { MetaDO };
import { normaliseTags, mergeTagSets } from './tags';

const ALLOWED_ORIGINS = [
  'https://victusfate.github.io',
  'https://boomerang-news.com',
  'https://www.boomerang-news.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
];

function extraOriginsFromEnv(env: Env): string[] {
  const raw = env.EXTRA_CORS_ORIGINS?.trim();
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function isAllowedOrigin(origin: string, env: Env): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (extraOriginsFromEnv(env).includes(origin)) return true;
  try {
    const u = new URL(origin);
    if (u.protocol === 'https:' && u.hostname.endsWith('.pages.dev')) return true;
    if (u.protocol !== 'http:') return false;
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function corsHeaders(request: Request, env: Env): Headers {
  const origin = request.headers.get('Origin') ?? '';
  const allow = isAllowedOrigin(origin, env) ? origin : ALLOWED_ORIGINS[0];
  const h = new Headers();
  h.set('Access-Control-Allow-Origin', allow);
  h.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  h.set('Vary', 'Origin');
  return h;
}

function json(data: unknown, request: Request, env: Env, init?: ResponseInit): Response {
  const headers = corsHeaders(request, env);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data), { ...init, headers });
}

interface ArticleMetaEntry {
  articleId: string;
  tags: string[];
  updatedAt: number;
}

const MAX_TAGS_PER_ARTICLE = 6;
const KV_TTL_SECONDS = 90 * 24 * 60 * 60;

function parseIdsParam(url: URL): string[] {
  const raw = url.searchParams.get('ids') ?? '';
  if (!raw.trim()) return [];
  return Array.from(new Set(raw.split(',').map(s => s.trim()).filter(Boolean)));
}

async function loadMetaEntries(env: Env, ids: string[]): Promise<ArticleMetaEntry[]> {
  const entries = await Promise.all(
    ids.map(id => env.ARTICLE_META.get<ArticleMetaEntry>(`meta:${id}`, 'json')),
  );
  return entries.filter((e): e is ArticleMetaEntry => e !== null);
}

async function upsertMetaEntry(env: Env, articleId: string, incomingTags: string[]): Promise<void> {
  const key = `meta:${articleId}`;
  const existing = await env.ARTICLE_META.get<ArticleMetaEntry>(key, 'json');
  const merged = mergeTagSets(existing?.tags ?? [], incomingTags).slice(0, MAX_TAGS_PER_ARTICLE);
  const updatedAt = Date.now();
  const entry: ArticleMetaEntry = { articleId, tags: merged, updatedAt };
  await env.ARTICLE_META.put(key, JSON.stringify(entry), { expirationTtl: KV_TTL_SECONDS });
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const id = env.META_DO.idFromName('global');
    const stub = env.META_DO.get(id);
    ctx.waitUntil(stub.fetch(new Request('http://do-internal/prune', { method: 'POST' })));
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (pathname === '/health' && request.method === 'GET') {
      return json({ ok: true, service: 'boomerang-meta' }, request, env);
    }

    if (pathname === '/meta' && request.method === 'GET') {
      const ids = parseIdsParam(url);
      if (ids.length === 0) return json({ updates: [] }, request, env);
      const updates = await loadMetaEntries(env, ids);
      return json({ updates }, request, env);
    }

    if (pathname === '/meta/tags' && request.method === 'POST') {
      let body: { articles?: Array<{ articleId?: unknown; tags?: unknown }> };
      try {
        body = await request.json() as { articles?: Array<{ articleId?: unknown; tags?: unknown }> };
      } catch {
        return json({ ok: false, message: 'Invalid JSON body' }, request, env, { status: 400 });
      }
      const articles = Array.isArray(body.articles) ? body.articles : [];
      for (const item of articles) {
        if (typeof item.articleId !== 'string' || !Array.isArray(item.tags)) continue;
        const tags = normaliseTags(item.tags.filter((t): t is string => typeof t === 'string'));
        if (tags.length === 0) continue;
        await upsertMetaEntry(env, item.articleId, tags);
      }
      return json({ ok: true }, request, env);
    }

    if (pathname === '/ws' && request.method === 'GET') {
      const upgrade = request.headers.get('Upgrade');
      if (upgrade?.toLowerCase() !== 'websocket') {
        return new Response('Upgrade Required', { status: 426, headers: corsHeaders(request, env) });
      }
      const id = env.META_DO.idFromName('global');
      const stub = env.META_DO.get(id);
      return stub.fetch(request);
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders(request, env) });
  },
} satisfies ExportedHandler<Env>;
