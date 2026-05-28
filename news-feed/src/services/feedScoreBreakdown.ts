import type { Article } from '../types';
import {
  inferFetchTier,
  recencyScore,
  diversityScore,
  recBoostScore,
  backgroundTierPenalty,
} from './algorithm.ts';

/** Mirrors `rankFeed` / `scoreArticle` in `algorithm.ts` for card UI. */
export interface FeedScoreInsight {
  mfScore: number | null;
  /** 1-based position in worker ranked list */
  recListRank: number | null;
  recRank01: number | null;
  recency: number;
  diversity: number;
  recBoost: number;
  tierMultiplier: number;
  fetchTier: 'fast' | 'background';
  composite: number;
  inRecList: boolean;
}

export interface RecRankEntry { rank01: number; listRank: number }

export function buildRecRankMap(recArticleIds: string[]): Map<string, RecRankEntry> {
  const len = recArticleIds.length;
  return new Map(recArticleIds.map((id, i) => [id, {
    rank01: i / Math.max(len - 1, 1),
    listRank: i + 1,
  }]));
}

export function countSourceArticles(articles: Article[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const a of articles) counts[a.sourceId] = (counts[a.sourceId] ?? 0) + 1;
  return counts;
}

export function computeFeedScoreInsight(
  article: Article,
  sourceCounts: Record<string, number>,
  recRankMap: Map<string, RecRankEntry>,
  mfScoreById: Record<string, number>,
): FeedScoreInsight {
  const recency = recencyScore(article.publishedAt);
  const diversity = diversityScore(sourceCounts, article.sourceId);
  const rankEntry = recRankMap.get(article.id);
  const recRank01 = rankEntry?.rank01;
  const recBoost = recBoostScore(recRank01);
  const fetchTier = inferFetchTier(article);
  const ageHours = (Date.now() - article.publishedAt.getTime()) / 3_600_000;
  const tierMultiplier = fetchTier === 'background' ? backgroundTierPenalty(ageHours) : 1;
  const composite = recency * diversity * recBoost * tierMultiplier;
  const mfRaw = mfScoreById[article.id];
  const mfScore = typeof mfRaw === 'number' && Number.isFinite(mfRaw) ? mfRaw : null;

  return {
    mfScore,
    recListRank: rankEntry?.listRank ?? null,
    recRank01: recRank01 ?? null,
    recency,
    diversity,
    recBoost,
    tierMultiplier,
    fetchTier,
    composite,
    inRecList: rankEntry !== undefined,
  };
}
