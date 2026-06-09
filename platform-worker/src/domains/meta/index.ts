import type { Env } from '../../env';
import { corsHeaders } from '../../cors';
import { json, tooManyRequests, checkRateLimit } from '../_shared/http';
import { normaliseTags, mergeTagSets } from './tags';

export { MetaDO } from './MetaDO';

const RATE_LIMIT_MAX_REQUESTS = 30;

const MAX_TAGS_PER_ARTICLE = 6;
/** Matches rec's MAX_ARTICLE_IDS_LOOKUP — bounds parallel KV reads per request. */
const MAX_META_IDS_LOOKUP = 50;
/** Matches MetaDO MAX_BATCH_SIZE — the WS path enforces the same cap. */
const MAX_META_TAGS_BATCH = 200;
/** articleId becomes a KV key — bound length and charset (ids are 16-hex today). */
const ARTICLE_ID_SHAPE = /^[\w-]{1,64}$/;

import type { ArticleRecord } from './articleRecord';
import { ARTICLE_RECORD_TTL_SECONDS, articleRecordKey } from './articleRecord';

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

async function upsertMetaEntry(env: Env, articleId: string, incomingTags: string[]): Promise<void> {
  const key = articleRecordKey(articleId);
  const existing = await env.ARTICLE_META.get<ArticleMetaEntry>(key, 'json');
  const merged = mergeTagSets(existing?.tags ?? [], incomingTags).slice(0, MAX_TAGS_PER_ARTICLE);
  const updatedAt = Date.now();
  const entry: ArticleMetaEntry = {
    articleId,
    tags: merged,
    updatedAt,
    title: existing?.title,
    source: existing?.source,
    sourceId: existing?.sourceId,
    publishedAt: existing?.publishedAt,
    url: existing?.url,
  };
  await env.ARTICLE_META.put(key, JSON.stringify(entry), { expirationTtl: ARTICLE_RECORD_TTL_SECONDS });
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
    const upserts: Promise<void>[] = [];
    for (const item of articles) {
      if (typeof item.articleId !== 'string' || !ARTICLE_ID_SHAPE.test(item.articleId) || !Array.isArray(item.tags)) continue;
      const tags = normaliseTags(item.tags.filter((t): t is string => typeof t === 'string'));
      if (tags.length === 0) continue;
      upserts.push(upsertMetaEntry(env, item.articleId, tags));
    }
    await Promise.all(upserts);
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
