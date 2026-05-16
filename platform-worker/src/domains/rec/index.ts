import type { Env } from '../../env';
import { corsHeaders } from '../../cors';
import type { RecCoreResponse, RecRankRequest, RecResponse } from '@victusfate/ricochet';
import { isValidEvent, REC_MAX_CANDIDATES } from '@victusfate/ricochet';
import {
  normalizeIdsParam,
  lookupArticleMetaByIds,
  hydrateArticleMetaFromFeeds,
  defaultBundleCacheRequest,
  getKvCounters,
} from './articleMeta';

export { RecDO } from '@victusfate/ricochet/worker';
export type { RecArticleMeta, RecArticlesResponse } from './articleMeta';

const RATE_LIMIT_INTERACTIONS_MAX = 60;
const RATE_LIMIT_RECS_MAX = 30;
const RATE_LIMIT_ARTICLES_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

const rateBuckets = new Map<string, { count: number; resetAt: number }>();

const MAX_BATCH_SIZE = 200;
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;
const CACHE_TTL_SECONDS = 300;
function parseLimit(rawLimit: unknown): number {
  if (typeof rawLimit === 'number' && Number.isFinite(rawLimit)) {
    return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(rawLimit)));
  }
  if (typeof rawLimit === 'string') {
    const parsed = parseInt(rawLimit, 10);
    if (!Number.isNaN(parsed)) return Math.max(1, Math.min(MAX_LIMIT, parsed));
  }
  return DEFAULT_LIMIT;
}

function parseCandidateArticleIds(value: unknown): { ids?: string[]; message?: string } {
  if (value === undefined) return {};
  if (!Array.isArray(value)) {
    return { message: 'candidateArticleIds must be an array of non-empty strings' };
  }
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string') return { message: 'candidateArticleIds must contain only strings' };
    const id = raw.trim();
    if (!id) return { message: 'candidateArticleIds must not contain empty IDs' };
    if (seen.has(id)) continue;
    seen.add(id);
    deduped.push(id);
  }
  if (deduped.length > REC_MAX_CANDIDATES) {
    return { message: `candidateArticleIds exceeds max ${REC_MAX_CANDIDATES}` };
  }
  return { ids: deduped };
}

function parseCandidatesCsv(raw: string | null): string[] | undefined {
  if (raw === null) return undefined;
  if (!raw.trim()) return [];
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push(id);
  }
  return deduped;
}

async function hashCandidateArticleIds(candidateArticleIds: string[]): Promise<string> {
  const sorted = [...candidateArticleIds].sort();
  const payload = new TextEncoder().encode(sorted.join(','));
  const digest = await crypto.subtle.digest('SHA-256', payload);
  const bytes = new Uint8Array(digest);
  return Array.from(bytes).slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function buildRecCacheKey(
  userId: string,
  limit: number,
  candidateArticleIds?: string[],
): Promise<string> {
  if (candidateArticleIds === undefined) return `recs:${userId}:limit:${limit}`;
  const poolHash = await hashCandidateArticleIds(candidateArticleIds);
  return `recs:${userId}:pool:${poolHash}:limit:${limit}`;
}

function json(data: unknown, request: Request, env: Env, init?: ResponseInit, cacheMaxAge?: number): Response {
  const headers = corsHeaders(request, env);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  if (cacheMaxAge !== undefined) headers.set('Cache-Control', `public, max-age=${cacheMaxAge}`);
  return new Response(JSON.stringify(data), { ...init, headers });
}

function tooManyRequests(request: Request, env: Env, retryAfterSeconds: number): Response {
  const headers = corsHeaders(request, env);
  headers.set('Retry-After', String(retryAfterSeconds));
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(
    JSON.stringify({ ok: false, message: 'Too Many Requests' }),
    { status: 429, headers },
  );
}

function getClientIp(request: Request): string | null {
  const cfIp = request.headers.get('CF-Connecting-IP');
  if (cfIp) return cfIp;
  const forwarded = request.headers.get('X-Forwarded-For');
  if (!forwarded) return null;
  return forwarded.split(',')[0]?.trim() || null;
}

function checkRateLimit(
  request: Request,
  key: string,
  max: number,
): { limited: false } | { limited: true; retryAfterSeconds: number } {
  const clientIp = getClientIp(request);
  if (!clientIp) return { limited: false };
  const now = Date.now();
  const bucketKey = `${key}:${clientIp}`;
  const existing = rateBuckets.get(bucketKey);
  if (!existing || existing.resetAt <= now) {
    rateBuckets.set(bucketKey, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { limited: false };
  }
  if (existing.count >= max) {
    return { limited: true, retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)) };
  }
  existing.count += 1;
  if (rateBuckets.size > 10_000) {
    for (const [k, bucket] of rateBuckets) {
      if (bucket.resetAt <= now) rateBuckets.delete(k);
    }
  }
  return { limited: false };
}

function getRecDOStub(env: Env): DurableObjectStub {
  const id = env.REC_DO.idFromName('global');
  return env.REC_DO.get(id);
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function ageSeconds(generatedAt: number): number {
  return Math.max(0, Math.floor((Date.now() - generatedAt) / 1000));
}

function normalizeCoreResponse(
  raw: Partial<RecCoreResponse> & Record<string, unknown>,
  limit: number,
): RecCoreResponse {
  const rawRecord = raw as Record<string, unknown>;
  const articleIds = Array.isArray(rawRecord.articleIds) ? rawRecord.articleIds.filter(id => typeof id === 'string') : [];
  const generatedAt = typeof raw.generatedAt === 'number' ? raw.generatedAt : Date.now();
  const scoredRaw = rawRecord.scoredArticleIds;
  const scoredArticleIds = Array.isArray(scoredRaw)
    ? scoredRaw.reduce<RecCoreResponse['scoredArticleIds']>((acc, row) => {
      if (!row || typeof row !== 'object') return acc;
      const item = row as Record<string, unknown>;
      if (typeof item.articleId !== 'string' || typeof item.score !== 'number') return acc;
      acc.push({ articleId: item.articleId, score: item.score });
      return acc;
    }, [])
    : articleIds.map((articleId, index) => ({
      articleId,
      score: 1 - (index / Math.max(articleIds.length - 1, 1)),
    }));
  const d = rawRecord.diagnostics && typeof rawRecord.diagnostics === 'object'
    ? rawRecord.diagnostics as Record<string, unknown>
    : {};
  const diagnostics = {
    model: 'biased-mf' as const,
    modelVersion: typeof d.modelVersion === 'string' ? d.modelVersion : 'unknown',
    factorCount: typeof d.factorCount === 'number' ? d.factorCount : 0,
    candidateMode: (d.candidateMode === 'feed-pool' || d.candidateMode === 'global')
      ? (d.candidateMode as 'feed-pool' | 'global')
      : undefined,
    candidateCount: typeof d.candidateCount === 'number' ? d.candidateCount : articleIds.length,
    rankedCount: typeof d.rankedCount === 'number' ? d.rankedCount : scoredArticleIds.length,
    returnedCount: typeof d.returnedCount === 'number' ? d.returnedCount : articleIds.length,
    excludedDownvotes: typeof d.excludedDownvotes === 'number' ? d.excludedDownvotes : 0,
    coldItemCount: typeof d.coldItemCount === 'number' ? d.coldItemCount : undefined,
    warmItemCount: typeof d.warmItemCount === 'number' ? d.warmItemCount : undefined,
    coldStart: typeof d.coldStart === 'boolean' ? d.coldStart : articleIds.length === 0,
    limit: typeof d.limit === 'number' ? d.limit : limit,
  };
  return { articleIds, generatedAt, scoredArticleIds, diagnostics };
}

function buildObservedResponse(
  request: Request,
  core: RecCoreResponse,
  cache: { status: 'hit' | 'miss' | 'bypass'; key: string; ageSec: number; ttlSec: number },
  timing: { total: number; cacheLookup: number; doFetch: number; cacheWrite: number },
): RecResponse {
  return {
    ...core,
    trace: {
      requestId: crypto.randomUUID(),
      cfRay: request.headers.get('cf-ray') ?? undefined,
    },
    cache,
    timingMs: timing,
  };
}

/** Consistent JSON error for /recommendations (and related rec failures). */
function recErrorJson(
  request: Request,
  env: Env,
  status: number,
  error: string,
  message: string,
  extra?: Record<string, unknown>,
): Response {
  return json(
    { ok: false, error, message, ...extra },
    request,
    env,
    { status },
  );
}

function errorDetail(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function handleRec(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  if (pathname === '/interactions' && request.method === 'POST') {
    const limited = checkRateLimit(request, 'interactions', RATE_LIMIT_INTERACTIONS_MAX);
    if (limited.limited) return tooManyRequests(request, env, limited.retryAfterSeconds);

    let body: { events?: unknown };
    try {
      body = await request.json() as { events?: unknown };
    } catch {
      return json({ ok: false, message: 'Invalid JSON body' }, request, env, { status: 400 });
    }

    if (!Array.isArray(body.events)) {
      return json(
        { ok: false, message: 'body.events must be an array' },
        request, env, { status: 400 },
      );
    }
    if (body.events.length > MAX_BATCH_SIZE) {
      return json(
        { ok: false, message: `Batch too large; max ${MAX_BATCH_SIZE} events` },
        request, env, { status: 400 },
      );
    }

    const valid = body.events.filter(isValidEvent);
    if (valid.length === 0) {
      return json({ ok: true, queued: 0 }, request, env);
    }

    const stub = getRecDOStub(env);
    await stub.fetch(new Request('http://do-internal/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(valid),
    }));

    return json({ ok: true, queued: valid.length }, request, env);
  }

  const recsMatch = pathname.match(/^\/recommendations\/(.+)$/);
  if (recsMatch && (request.method === 'GET' || request.method === 'POST')) {
    try {
      const limited = checkRateLimit(request, 'recs', RATE_LIMIT_RECS_MAX);
    if (limited.limited) return tooManyRequests(request, env, limited.retryAfterSeconds);

    const tStart = nowMs();
    const userId = recsMatch[1];
    let limit = parseLimit(url.searchParams.get('limit'));
    let candidateArticleIds: string[] | undefined;
    let candidateModeProvided = false;

    if (request.method === 'GET') {
      candidateModeProvided = url.searchParams.has('candidates');
      candidateArticleIds = parseCandidatesCsv(url.searchParams.get('candidates'));
    } else {
      let body: RecRankRequest | null;
      try {
        body = await request.json() as RecRankRequest | null;
      } catch {
        return json({ ok: false, message: 'Invalid JSON body' }, request, env, { status: 400 });
      }
      if (body !== null && typeof body !== 'object') {
        return json({ ok: false, message: 'Invalid JSON body' }, request, env, { status: 400 });
      }
      candidateModeProvided = body !== null
        && Object.prototype.hasOwnProperty.call(body, 'candidateArticleIds');
      const parsed = parseCandidateArticleIds(body?.candidateArticleIds);
      if (parsed.message) {
        return json({ ok: false, message: parsed.message }, request, env, { status: 400 });
      }
      candidateArticleIds = parsed.ids;
      if (body?.limit !== undefined) limit = parseLimit(body.limit);
    }

    if (candidateArticleIds && candidateArticleIds.length > REC_MAX_CANDIDATES) {
      return json(
        { ok: false, message: `candidateArticleIds exceeds max ${REC_MAX_CANDIDATES}` },
        request,
        env,
        { status: 400 },
      );
    }

    const cacheKey = await buildRecCacheKey(
      userId,
      limit,
      candidateModeProvided ? (candidateArticleIds ?? []) : undefined,
    );
    const tAfterCacheLookupStart = nowMs();
    const cachedRaw = await env.REC_STORE.get(cacheKey, 'json') as (Partial<RecCoreResponse> & Record<string, unknown>) | null;
    const cacheLookupMs = nowMs() - tAfterCacheLookupStart;
    if (cachedRaw?.scoredArticleIds && cachedRaw?.diagnostics) {
      const cached = normalizeCoreResponse(cachedRaw, limit);
      const response = buildObservedResponse(
        request,
        cached,
        { status: 'hit', key: cacheKey, ageSec: ageSeconds(cached.generatedAt), ttlSec: CACHE_TTL_SECONDS },
        {
          total: nowMs() - tStart,
          cacheLookup: cacheLookupMs,
          doFetch: 0,
          cacheWrite: 0,
        },
      );
      return json(response, request, env);
    }

    const cacheStatus: 'hit' | 'miss' | 'bypass' = cachedRaw ? 'bypass' : 'miss';

    const stub = getRecDOStub(env);
    const tDoFetchStart = nowMs();
    const doRes = candidateModeProvided
      ? await stub.fetch(
        new Request(`http://do-internal/recs/${encodeURIComponent(userId)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ candidateArticleIds: candidateArticleIds ?? [], limit }),
        }),
      )
      : await stub.fetch(
        new Request(`http://do-internal/recs/${encodeURIComponent(userId)}?limit=${limit}`),
      );
    const doFetchMs = nowMs() - tDoFetchStart;
    if (!doRes.ok) {
      const raw = await doRes.text();
      let message = raw.trim() || 'Recommendation durable object returned an error';
      try {
        const parsed = JSON.parse(raw) as { message?: string };
        if (typeof parsed?.message === 'string' && parsed.message.length > 0) message = parsed.message;
      } catch {
        /* plain text body */
      }
      const outStatus = doRes.status >= 400 && doRes.status < 600 ? doRes.status : 502;
      return recErrorJson(request, env, outStatus, 'rec_do_failed', message, {
        doStatus: doRes.status,
      });
    }
    let recCoreRaw: Partial<RecCoreResponse> & Record<string, unknown>;
    try {
      recCoreRaw = await doRes.json() as (Partial<RecCoreResponse> & Record<string, unknown>);
    } catch {
      return recErrorJson(
        request,
        env,
        502,
        'rec_do_invalid_json',
        'Recommendation service returned a non-JSON body after a successful status.',
      );
    }
    const recCore = normalizeCoreResponse(recCoreRaw, limit);

    const tCacheWriteStart = nowMs();
    await env.REC_STORE.put(cacheKey, JSON.stringify(recCore), { expirationTtl: CACHE_TTL_SECONDS });
    const cacheWriteMs = nowMs() - tCacheWriteStart;
    const response = buildObservedResponse(
      request,
      recCore,
      { status: cacheStatus, key: cacheKey, ageSec: 0, ttlSec: CACHE_TTL_SECONDS },
      {
        total: nowMs() - tStart,
        cacheLookup: cacheLookupMs,
        doFetch: doFetchMs,
        cacheWrite: cacheWriteMs,
      },
    );
    return json(response, request, env);
    } catch (err) {
      return recErrorJson(
        request,
        env,
        500,
        'rec_internal_error',
        'Recommendation ranking failed.',
        { detail: errorDetail(err) },
      );
    }
  }

  if (pathname === '/rec/articles' && request.method === 'GET') {
    const limited = checkRateLimit(request, 'rec-articles', RATE_LIMIT_ARTICLES_MAX);
    if (limited.limited) return tooManyRequests(request, env, limited.retryAfterSeconds);

    const ids = normalizeIdsParam(url.searchParams.get('ids'));
    if (ids.length === 0) {
      return json({ ok: true, requested: 0, found: 0, missing: [], articles: [] }, request, env);
    }
    const body = await lookupArticleMetaByIds(env, ids);
    if (body.missing.length > 0) {
      const bundleCacheReq = defaultBundleCacheRequest(request);
      ctx.waitUntil(
        hydrateArticleMetaFromFeeds(env, body.missing, bundleCacheReq).catch(() => {}),
      );
    }
    return json(body, request, env, undefined, 3600);
  }

  if (pathname === '/rec/debug' && request.method === 'GET') {
    const stub = getRecDOStub(env);
    const [gs, uc, ic, iic] = await Promise.all([
      stub.fetch('http://do-internal/debug/global-state').then(r => r.json()),
      stub.fetch('http://do-internal/debug/user-factors-count').then(r => r.json()),
      stub.fetch('http://do-internal/debug/item-factors-count').then(r => r.json()),
      stub.fetch('http://do-internal/debug/interactions-count').then(r => r.json()),
    ]);
    return json(
      { globalState: gs, userFactorsCount: uc, itemFactorsCount: ic, interactionsCount: iic, kvCounters: getKvCounters() },
      request, env,
    );
  }

  return new Response('Not Found', { status: 404, headers: corsHeaders(request, env) });
}

export async function scheduledRec(env: Env, ctx: ExecutionContext): Promise<void> {
  const stub = getRecDOStub(env);
  ctx.waitUntil(stub.fetch(new Request('http://do-internal/prune', { method: 'POST' })));
}
