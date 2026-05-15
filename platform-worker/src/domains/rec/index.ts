import type { Env } from '../../env';
import { corsHeaders } from '../../cors';
import type { RecCoreResponse, RecResponse } from '@victusfate/ricochet';
import { isValidEvent } from '@victusfate/ricochet';

export { RecDO } from './RecDO';

const RATE_LIMIT_INTERACTIONS_MAX = 60;
const RATE_LIMIT_RECS_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

const rateBuckets = new Map<string, { count: number; resetAt: number }>();

const MAX_BATCH_SIZE = 200;
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const CACHE_TTL_SECONDS = 300;

function json(data: unknown, request: Request, env: Env, init?: ResponseInit): Response {
  const headers = corsHeaders(request, env);
  headers.set('Content-Type', 'application/json; charset=utf-8');
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
    candidateCount: typeof d.candidateCount === 'number' ? d.candidateCount : articleIds.length,
    rankedCount: typeof d.rankedCount === 'number' ? d.rankedCount : scoredArticleIds.length,
    returnedCount: typeof d.returnedCount === 'number' ? d.returnedCount : articleIds.length,
    excludedDownvotes: typeof d.excludedDownvotes === 'number' ? d.excludedDownvotes : 0,
    coldStart: typeof d.coldStart === 'boolean' ? d.coldStart : articleIds.length === 0,
    limit: typeof d.limit === 'number' ? d.limit : limit,
  };
  return { articleIds, generatedAt, scoredArticleIds, diagnostics };
}

function buildObservedResponse(
  request: Request,
  core: RecCoreResponse,
  cache: { status: 'hit' | 'miss'; key: string; ageSec: number; ttlSec: number },
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

export async function handleRec(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
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
  if (recsMatch && request.method === 'GET') {
    const limited = checkRateLimit(request, 'recs', RATE_LIMIT_RECS_MAX);
    if (limited.limited) return tooManyRequests(request, env, limited.retryAfterSeconds);

    const tStart = nowMs();
    const userId = recsMatch[1];
    const rawLimit = parseInt(url.searchParams.get('limit') ?? String(DEFAULT_LIMIT), 10);
    const limit = Math.min(isNaN(rawLimit) || rawLimit < 1 ? DEFAULT_LIMIT : rawLimit, MAX_LIMIT);

    const cacheKey = `recs:${userId}`;
    const tAfterCacheLookupStart = nowMs();
    const cachedRaw = await env.REC_STORE.get(cacheKey, 'json') as (Partial<RecCoreResponse> & Record<string, unknown>) | null;
    const cacheLookupMs = nowMs() - tAfterCacheLookupStart;
    if (cachedRaw) {
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

    const stub = getRecDOStub(env);
    const tDoFetchStart = nowMs();
    const doRes = await stub.fetch(
      new Request(`http://do-internal/recs/${encodeURIComponent(userId)}?limit=${limit}`),
    );
    const doFetchMs = nowMs() - tDoFetchStart;
    const recCoreRaw = await doRes.json() as (Partial<RecCoreResponse> & Record<string, unknown>);
    const recCore = normalizeCoreResponse(recCoreRaw, limit);

    const tCacheWriteStart = nowMs();
    await env.REC_STORE.put(cacheKey, JSON.stringify(recCore), { expirationTtl: CACHE_TTL_SECONDS });
    const cacheWriteMs = nowMs() - tCacheWriteStart;
    const response = buildObservedResponse(
      request,
      recCore,
      { status: 'miss', key: cacheKey, ageSec: 0, ttlSec: CACHE_TTL_SECONDS },
      {
        total: nowMs() - tStart,
        cacheLookup: cacheLookupMs,
        doFetch: doFetchMs,
        cacheWrite: cacheWriteMs,
      },
    );
    return json(response, request, env);
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
      { globalState: gs, userFactorsCount: uc, itemFactorsCount: ic, interactionsCount: iic },
      request, env,
    );
  }

  return new Response('Not Found', { status: 404, headers: corsHeaders(request, env) });
}

export async function scheduledRec(env: Env, ctx: ExecutionContext): Promise<void> {
  const stub = getRecDOStub(env);
  ctx.waitUntil(stub.fetch(new Request('http://do-internal/prune', { method: 'POST' })));
}
