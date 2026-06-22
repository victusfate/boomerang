import type { RecDiagnostics, RecResponse, ScoredArticle } from '@victusfate/ricochet';
import { REC_MAX_CANDIDATES } from '@victusfate/ricochet';

export { REC_MAX_CANDIDATES };

/** Max feed-pool ids sent for MF ranking (top of locally ranked list). */
export const REC_POOL_CANDIDATE_CAP = 400;

const REC_CACHE_TTL_SEC = 300;

export type RecResponseWithScores = RecResponse & {
  scoreById: Record<string, number>;
};

export function capRecCandidateIds(ids: string[], cap = REC_POOL_CANDIDATE_CAP): string[] {
  if (ids.length <= cap) return ids;
  return ids.slice(0, cap);
}

export function dedupeArticleIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Maps a 0-based rank index to a normalized score in [0, 1]: top-ranked → 1, bottom-ranked → 0. */
export function rankScore01(i: number, len: number): number {
  return 1 - (i / Math.max(len - 1, 1));
}

export function chunkArticleIds(ids: string[], batchSize = REC_MAX_CANDIDATES): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    chunks.push(ids.slice(i, i + batchSize));
  }
  return chunks;
}

/** Merge batched feed-pool responses into one global ranking (highest score first). */
export function mergeFeedPoolRecResponses(
  parts: RecResponseWithScores[],
  totalCandidates: number,
): RecResponseWithScores {
  if (parts.length === 0) {
    const emptyDiagnostics: RecDiagnostics = {
      model: 'biased-mf',
      modelVersion: 'unknown',
      factorCount: 0,
      candidateMode: 'feed-pool',
      candidateCount: 0,
      rankedCount: 0,
      returnedCount: 0,
      excludedDownvotes: 0,
      coldStart: true,
      limit: 0,
    };
    return {
      articleIds: [],
      generatedAt: Date.now(),
      scoredArticleIds: [],
      diagnostics: emptyDiagnostics,
      trace: { requestId: 'client-empty' },
      cache: { status: 'bypass', key: 'recs:merged', ttlSec: REC_CACHE_TTL_SEC, ageSec: 0 },
      timingMs: { total: 0, cacheLookup: 0, doFetch: 0, cacheWrite: 0 },
      scoreById: {},
    };
  }

  const bestById = new Map<string, number>();
  for (const part of parts) {
    for (const row of part.scoredArticleIds) {
      const prev = bestById.get(row.articleId);
      if (prev === undefined || row.score > prev) bestById.set(row.articleId, row.score);
    }
  }

  const scoredArticleIds: ScoredArticle[] = [...bestById.entries()]
    .map(([articleId, score]) => ({ articleId, score }))
    .sort((a, b) => b.score - a.score || a.articleId.localeCompare(b.articleId));

  const articleIds = scoredArticleIds.map(r => r.articleId);
  const scoreById = Object.fromEntries(scoredArticleIds.map(r => [r.articleId, r.score]));
  const generatedAt = Math.max(...parts.map(p => p.generatedAt));
  const last = parts[parts.length - 1];

  let excludedDownvotes = 0;
  let coldItemCount = 0;
  let warmItemCount = 0;
  let factorCount = 0;
  for (const p of parts) {
    excludedDownvotes += p.diagnostics.excludedDownvotes;
    coldItemCount += p.diagnostics.coldItemCount ?? 0;
    warmItemCount += p.diagnostics.warmItemCount ?? 0;
    factorCount = Math.max(factorCount, p.diagnostics.factorCount);
  }

  return {
    articleIds,
    generatedAt,
    scoredArticleIds,
    diagnostics: {
      model: 'biased-mf',
      modelVersion: last.diagnostics.modelVersion,
      factorCount,
      candidateMode: 'feed-pool',
      candidateCount: totalCandidates,
      rankedCount: scoredArticleIds.length,
      returnedCount: articleIds.length,
      excludedDownvotes,
      coldItemCount,
      warmItemCount,
      coldStart: parts.some(p => p.diagnostics.coldStart),
      limit: articleIds.length,
    },
    trace: last.trace,
    cache: { ...last.cache, key: `recs:feed-pool:${parts.length}b` },
    timingMs: {
      total: parts.reduce((s, p) => s + p.timingMs.total, 0),
      cacheLookup: parts.reduce((s, p) => s + p.timingMs.cacheLookup, 0),
      doFetch: parts.reduce((s, p) => s + p.timingMs.doFetch, 0),
      cacheWrite: parts.reduce((s, p) => s + p.timingMs.cacheWrite, 0),
    },
    scoreById,
  };
}
