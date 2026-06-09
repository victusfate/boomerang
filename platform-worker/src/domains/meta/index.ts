import type { Env } from '../../env';
import { corsHeaders } from '../../cors';
import { json, tooManyRequests, checkRateLimit } from '../_shared/http';
import { normaliseTags } from './tags';

export { MetaDO } from './MetaDO';

const RATE_LIMIT_MAX_REQUESTS = 30;

/** Matches rec's MAX_ARTICLE_IDS_LOOKUP — bounds parallel KV reads per request. */
const MAX_META_IDS_LOOKUP = 50;
/** Matches MetaDO MAX_BATCH_SIZE — the WS path enforces the same cap. */
const MAX_META_TAGS_BATCH = 200;
/** articleId becomes a KV key — bound length and charset (ids are 16-hex today). */
const ARTICLE_ID_SHAPE = /^[\w-]{1,64}$/;

import type { ArticleRecord } from './articleRecord';
import { articleRecordKey } from './articleRecord';

type ArticleMetaEntry = ArticleRecord;

function parseIdsParam(url: URL): string[] {
  const raw = url.searchParams.get('ids') ?? '';
  if (!raw.trim()) return [];
  return Array.from(new Set(raw.split(',').map(s => s.trim()).filter(Boolean)))
    .slice(0, MAX_META_IDS_LOOKUP);
}

async function loadMetaEntries(env: Env, ids: string[]): Promise<ArticleMetaEntry[]> {
  const entries = await Promise.all(
    ids.map(id => env.ARTICLE_META.get<ArticleMetaEntry>(articleRecordKey(id), 'json')),
  );
  return entries.filter((e): e is ArticleMetaEntry => e !== null);
}

export async function handleMeta(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  if (pathname === '/meta' && request.method === 'GET') {
    const limited = checkRateLimit(request, 'meta', RATE_LIMIT_MAX_REQUESTS);
    if (limited.limited) return tooManyRequests(request, env, limited.retryAfterSeconds);
    const ids = parseIdsParam(url);
    if (ids.length === 0) return json({ updates: [] }, request, env);
    const updates = await loadMetaEntries(env, ids);
    return json({ updates }, request, env);
  }

  if (pathname === '/meta/tags' && request.method === 'POST') {
    const limited = checkRateLimit(request, 'meta', RATE_LIMIT_MAX_REQUESTS);
    if (limited.limited) return tooManyRequests(request, env, limited.retryAfterSeconds);
    let body: { articles?: Array<{ articleId?: unknown; tags?: unknown }> };
    try {
      body = await request.json() as { articles?: Array<{ articleId?: unknown; tags?: unknown }> };
    } catch {
      return json({ ok: false, message: 'Invalid JSON body' }, request, env, { status: 400 });
    }
    const articles = Array.isArray(body.articles) ? body.articles : [];
    if (articles.length > MAX_META_TAGS_BATCH) {
      return json(
        { ok: false, message: `articles must contain at most ${MAX_META_TAGS_BATCH} entries` },
        request, env, { status: 400 },
      );
    }
    const valid: Array<{ articleId: string; tags: string[] }> = [];
    for (const item of articles) {
      if (typeof item.articleId !== 'string' || !ARTICLE_ID_SHAPE.test(item.articleId) || !Array.isArray(item.tags)) continue;
      const tags = normaliseTags(item.tags.filter((t): t is string => typeof t === 'string'));
      if (tags.length === 0) continue;
      valid.push({ articleId: item.articleId, tags });
    }
    if (valid.length > 0) {
      // Route through MetaDO — single tag writer, and HTTP-submitted tags
      // reach WS subscribers + the catchUp index like WS submissions.
      const id = env.META_DO.idFromName('global');
      const stub = env.META_DO.get(id);
      const doRes = await stub.fetch(new Request('http://do-internal/submit-tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ articles: valid }),
      }));
      if (!doRes.ok) {
        return json({ ok: false, message: `Tag submit failed (${doRes.status})` }, request, env, { status: 502 });
      }
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
}

export async function scheduledMeta(env: Env): Promise<void> {
  const id = env.META_DO.idFromName('global');
  const stub = env.META_DO.get(id);
  await stub.fetch(new Request('http://do-internal/prune', { method: 'POST' }));
}
