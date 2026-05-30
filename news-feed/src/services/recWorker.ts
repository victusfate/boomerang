/**
 * Ricochet rec-worker client — interaction posting, feed-pool recommendations, ETag caching.
 * @module services/recWorker
 * @category Recommendations
 */

import type {
  Action,
  InteractionEvent,
  RecResponse,
  RecDiagnostics,
  RecCacheInfo,
  RecTimingMs,
  RecTraceInfo,
  ScoredArticle,
} from '@victusfate/ricochet';
import type { Topic } from '../types';
import { kvGet, kvSet } from './kvStore';
import { parseRecArticlesResponse, type RecArticlesResponse } from './recArticlesLookup';
import {
  capRecCandidateIds,
  chunkArticleIds,
  dedupeArticleIds,
  mergeFeedPoolRecResponses,
  rankScore01,
  type RecResponseWithScores,
} from './recPoolMerge';

export type { RecArticleMeta, RecArticlesLookupTiming, RecArticlesResponse } from './recArticlesLookup';
export { normalizeRecArticleMeta, parseRecArticlesResponse } from './recArticlesLookup';

export type RecAction = Action;

export interface RecInteractionInput {
  articleId: string;
  sourceId:  string;
  topics:    Topic[];
  tags?:     string[];
  action:    RecAction;
  ts:        number;   // epoch ms — set at interaction time, not flush time
}

export type { RecResponse };
export type { RecResponseWithScores } from './recPoolMerge';
export {
  REC_MAX_CANDIDATES,
  REC_POOL_CANDIDATE_CAP,
  capRecCandidateIds,
  dedupeArticleIds,
  chunkArticleIds,
  mergeFeedPoolRecResponses,
  rankScore01,
} from './recPoolMerge';

const USER_ID_KEY = 'rec:userId';

export async function getOrCreateRecUserId(): Promise<string> {
  const existing = await kvGet<string>(USER_ID_KEY);
  if (existing) return existing;
  const id = crypto.randomUUID();
  await kvSet(USER_ID_KEY, id);
  return id;
}

export async function postInteractions(
  workerBase: string,
  userId: string,
  inputs: RecInteractionInput[],
): Promise<void> {
  const events: InteractionEvent[] = inputs.map(e => ({ ...e, userId }));
  const res = await fetch(`${workerBase}/interactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
  });
  if (!res.ok) throw new Error(`interactions ${res.status} ${res.statusText}`);
}

export interface FetchRecommendationsOptions {
  candidateArticleIds?: string[];
  limit?: number;
  topicWeights?: Partial<Record<string, number>>;
}

/** ETag cache: avoids redundant payload when the ranked list hasn't changed. Max 50 entries (LRU-evict oldest). */
const REC_ETAG_STORE_MAX = 50;
const recETagStore = new Map<string, { etag: string; response: RecResponseWithScores }>();

function recETagSet(key: string, value: { etag: string; response: RecResponseWithScores }): void {
  recETagStore.delete(key); // refresh insertion order (LRU move-to-end)
  recETagStore.set(key, value);
  if (recETagStore.size > REC_ETAG_STORE_MAX) {
    recETagStore.delete(recETagStore.keys().next().value!);
  }
}

/** Rank the full feed pool in batches of ≤`REC_MAX_CANDIDATES`, merged by MF score for `rankFeed`. */
export async function fetchFeedPoolRecommendations(
  workerBase: string,
  userId: string,
  candidateArticleIds: string[],
  topicWeights?: Partial<Record<string, number>>,
): Promise<RecResponseWithScores> {
  const ids = capRecCandidateIds(dedupeArticleIds(candidateArticleIds));
  if (ids.length === 0) {
    return mergeFeedPoolRecResponses([], 0);
  }

  const chunks = chunkArticleIds(ids);
  const parts: RecResponseWithScores[] = [];
  for (const chunk of chunks) {
    parts.push(await fetchRecommendations(workerBase, userId, {
      candidateArticleIds: chunk,
      limit: chunk.length,
      topicWeights,
    }));
  }
  return mergeFeedPoolRecResponses(parts, ids.length);
}

export async function fetchRecommendations(
  workerBase: string,
  userId: string,
  options: FetchRecommendationsOptions | number = 50,
): Promise<RecResponseWithScores> {
  const opts: FetchRecommendationsOptions = typeof options === 'number'
    ? { limit: options }
    : options;
  const limit = opts.limit ?? 50;
  const useFeedPool = opts.candidateArticleIds !== undefined;
  // Strip undefined values; only send when there are actual learned weights.
  // An empty object bypasses ricochet's KV cache and prevents ETags from firing.
  const weightEntries = opts.topicWeights
    ? Object.entries(opts.topicWeights).filter((e): e is [string, number] => e[1] !== undefined)
    : [];
  const filteredWeights = weightEntries.length > 0 ? Object.fromEntries(weightEntries) : undefined;

  // Per-chunk ETag key: include length to avoid collisions across pools sharing a leading ID.
  const etagKey = opts.candidateArticleIds && opts.candidateArticleIds.length > 0
    ? `${userId}:${opts.candidateArticleIds.length}:${opts.candidateArticleIds[0]}`
    : userId;
  const cached = recETagStore.get(etagKey);
  const reqHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cached) reqHeaders['If-None-Match'] = cached.etag;

  const res = useFeedPool
    ? await fetch(`${workerBase}/recommendations/${encodeURIComponent(userId)}`, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify({
        candidateArticleIds: opts.candidateArticleIds,
        limit,
        ...(filteredWeights ? { topicWeights: filteredWeights } : {}),
      }),
    })
    : await fetch(
      `${workerBase}/recommendations/${encodeURIComponent(userId)}?limit=${limit}`,
      { headers: reqHeaders },
    );

  if (res.status === 304 && cached) return cached.response;
  if (!res.ok) throw new Error(`rec-worker ${res.status} ${res.statusText}`);
  const raw = await res.json() as Partial<RecResponse> & Record<string, unknown>;
  const articleIds = Array.isArray(raw.articleIds) ? raw.articleIds : [];
  const generatedAt = typeof raw.generatedAt === 'number' ? raw.generatedAt : Date.now();
  const scoredArticleIds = normalizeScoredArticles(raw.scoredArticleIds, articleIds);
  const diagnostics = normalizeDiagnostics(raw.diagnostics, articleIds.length, limit);
  const trace = normalizeTrace(raw.trace);
  const cache = normalizeCache(raw.cache, generatedAt, userId);
  const timingMs = normalizeTiming(raw.timingMs);
  const scoreById = scoredArticleIds.length > 0
    ? Object.fromEntries(scoredArticleIds.map(row => [row.articleId, row.score]))
    : deriveRankScores(articleIds);
  const result: RecResponseWithScores = { articleIds, generatedAt, scoredArticleIds, diagnostics, trace, cache, timingMs, scoreById };
  const etag = res.headers.get('ETag');
  if (etag) recETagSet(etagKey, { etag, response: result });
  return result;
}

function normalizeScoredArticles(
  candidate: unknown,
  articleIds: string[],
): ScoredArticle[] {
  if (!Array.isArray(candidate)) {
    return articleIds.map((articleId, index) => ({
      articleId,
      score: rankScore01(index, articleIds.length),
    }));
  }
  const rows = candidate.reduce<ScoredArticle[]>((acc, row) => {
    if (!row || typeof row !== 'object') return acc;
    const item = row as Record<string, unknown>;
    if (typeof item.articleId !== 'string' || typeof item.score !== 'number') return acc;
    acc.push({ articleId: item.articleId, score: item.score });
    return acc;
  }, []);
  if (rows.length > 0) return rows;
  return articleIds.map((articleId, index) => ({
    articleId,
    score: 1 - (index / Math.max(articleIds.length - 1, 1)),
  }));
}

function normalizeDiagnostics(candidate: unknown, count: number, limit: number): RecDiagnostics {
  const d = (candidate && typeof candidate === 'object')
    ? candidate as Partial<RecDiagnostics>
    : {};
  return {
    model: 'biased-mf',
    modelVersion: typeof d.modelVersion === 'string' ? d.modelVersion : 'unknown',
    factorCount: typeof d.factorCount === 'number' ? d.factorCount : 0,
    candidateMode: d.candidateMode === 'feed-pool' || d.candidateMode === 'global'
      ? d.candidateMode
      : undefined,
    candidateCount: typeof d.candidateCount === 'number' ? d.candidateCount : count,
    rankedCount: typeof d.rankedCount === 'number' ? d.rankedCount : count,
    returnedCount: typeof d.returnedCount === 'number' ? d.returnedCount : count,
    excludedDownvotes: typeof d.excludedDownvotes === 'number' ? d.excludedDownvotes : 0,
    coldItemCount: typeof d.coldItemCount === 'number' ? d.coldItemCount : undefined,
    warmItemCount: typeof d.warmItemCount === 'number' ? d.warmItemCount : undefined,
    coldStart: typeof d.coldStart === 'boolean' ? d.coldStart : count === 0,
    limit: typeof d.limit === 'number' ? d.limit : limit,
  };
}

function normalizeTrace(candidate: unknown): RecTraceInfo {
  const t = (candidate && typeof candidate === 'object')
    ? candidate as Partial<RecTraceInfo>
    : {};
  return {
    requestId: typeof t.requestId === 'string' ? t.requestId : 'client-fallback',
    cfRay: typeof t.cfRay === 'string' ? t.cfRay : undefined,
  };
}

function normalizeCache(candidate: unknown, generatedAt: number, userId: string): RecCacheInfo {
  const c = (candidate && typeof candidate === 'object')
    ? candidate as Partial<RecCacheInfo>
    : {};
  const ageSec = Math.max(0, Math.floor((Date.now() - generatedAt) / 1000));
  return {
    status: c.status === 'hit' || c.status === 'miss' || c.status === 'bypass' ? c.status : 'bypass',
    key: typeof c.key === 'string' ? c.key : `recs:${userId}`,
    ttlSec: typeof c.ttlSec === 'number' ? c.ttlSec : 300,
    ageSec: typeof c.ageSec === 'number' ? c.ageSec : ageSec,
  };
}

function normalizeTiming(candidate: unknown): RecTimingMs {
  const t = (candidate && typeof candidate === 'object')
    ? candidate as Partial<RecTimingMs>
    : {};
  return {
    total: typeof t.total === 'number' ? t.total : 0,
    cacheLookup: typeof t.cacheLookup === 'number' ? t.cacheLookup : 0,
    doFetch: typeof t.doFetch === 'number' ? t.doFetch : 0,
    cacheWrite: typeof t.cacheWrite === 'number' ? t.cacheWrite : 0,
  };
}

function deriveRankScores(articleIds: string[]): Record<string, number> {
  if (articleIds.length === 0) return {};
  if (articleIds.length === 1) return { [articleIds[0]]: 1 };
  return articleIds.reduce<Record<string, number>>((acc, id, index) => {
    acc[id] = rankScore01(index, articleIds.length);
    return acc;
  }, {});
}

export interface RecDebugInfo {
  globalState: { mean: number; n: number };
  userFactorsCount: { count: number };
  itemFactorsCount: { count: number };
  interactionsCount: { count: number };
  kvCounters?: { reads: number; writes: number; memHits: number };
}

export async function fetchRecDiagnostics(workerBase: string): Promise<RecDebugInfo> {
  const res = await fetch(`${workerBase}/rec/debug`);
  if (!res.ok) throw new Error(`rec-debug ${res.status}`);
  return res.json() as Promise<RecDebugInfo>;
}

export async function fetchRecArticles(
  workerBase: string,
  ids: string[],
): Promise<RecArticlesResponse> {
  const uniqueIds = Array.from(new Set(ids));
  if (uniqueIds.length === 0) {
    return { ok: true, requested: 0, found: 0, missing: [], articles: [] };
  }
  const res = await fetch(
    `${workerBase}/rec/articles?ids=${encodeURIComponent(uniqueIds.join(','))}`,
  );
  if (!res.ok) throw new Error(`rec-articles ${res.status}`);
  return parseRecArticlesResponse(await res.json());
}
