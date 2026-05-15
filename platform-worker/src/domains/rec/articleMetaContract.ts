/**
 * Article catalog — primary store: ARTICLE_META KV `meta:<id>`.
 * RecArticleMeta and RecArticlesResponse are intentionally mirrored in
 * `news-feed/src/services/recArticlesLookup.ts` to avoid bundling worker
 * code into the client bundle. Keep both in sync when fields change.
 */

import { ARTICLE_RECORD_TTL_SECONDS } from '../../../../shared/articleRecordCatalog.ts';

/** @deprecated Legacy REC_STORE keys; read fallback only during migration */
export const ARTICLE_META_KEY_PREFIX = 'rec:article-meta:';
/** Matches ARTICLE_META KV TTL (see shared/articleRecordCatalog.ts) */
export const ARTICLE_META_TTL_SECONDS = ARTICLE_RECORD_TTL_SECONDS;
export const MAX_ARTICLE_IDS_LOOKUP = 50;

export interface RecArticleMeta {
  id: string;
  title: string;
  source: string;
  sourceId: string;
  publishedAt: string;
  url: string;
}

export interface RecArticlesResponse {
  ok: true;
  requested: number;
  found: number;
  missing: string[];
  articles: RecArticleMeta[];
  timingMs?: {
    kvLookup: number;
    hydrate: number;
    total: number;
  };
}

export function articleMetaCacheKey(id: string): string {
  return `${ARTICLE_META_KEY_PREFIX}${id}`;
}

export function normalizeIdsParam(raw: string | null): string[] {
  if (!raw) return [];
  const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
  return Array.from(new Set(ids)).slice(0, MAX_ARTICLE_IDS_LOOKUP);
}

export function normalizeArticleMeta(candidate: unknown): RecArticleMeta | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const r = candidate as Record<string, unknown>;
  if (
    typeof r.id !== 'string'
    || typeof r.title !== 'string'
    || typeof r.source !== 'string'
    || typeof r.sourceId !== 'string'
    || typeof r.publishedAt !== 'string'
    || typeof r.url !== 'string'
  ) return null;
  return {
    id: r.id,
    title: r.title,
    source: r.source,
    sourceId: r.sourceId,
    publishedAt: r.publishedAt,
    url: r.url,
  };
}

export function wireArticleFromFeed(article: {
  id: string;
  title: string;
  source: string;
  sourceId: string;
  publishedAt: string;
  url: string;
}): RecArticleMeta {
  return {
    id: article.id,
    title: article.title,
    source: article.source,
    sourceId: article.sourceId,
    publishedAt: article.publishedAt,
    url: article.url,
  };
}
