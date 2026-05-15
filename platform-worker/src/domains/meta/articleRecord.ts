/** Unified per-article KV record in ARTICLE_META (tags + catalog fields). */

export { ARTICLE_RECORD_TTL_SECONDS } from '../../../../shared/articleRecordCatalog.ts';

export const ARTICLE_RECORD_KV_PREFIX = 'meta:';

export interface ArticleRecord {
  articleId: string;
  tags: string[];
  updatedAt: number;
  title?: string;
  source?: string;
  sourceId?: string;
  publishedAt?: string;
  url?: string;
}

export interface ArticleCatalog {
  id: string;
  title: string;
  source: string;
  sourceId: string;
  publishedAt: string;
  url: string;
}

export function articleRecordKey(articleId: string): string {
  return `${ARTICLE_RECORD_KV_PREFIX}${articleId}`;
}

export function isArticleRecord(candidate: unknown): candidate is ArticleRecord {
  if (!candidate || typeof candidate !== 'object') return false;
  const r = candidate as Record<string, unknown>;
  return typeof r.articleId === 'string' && Array.isArray(r.tags) && typeof r.updatedAt === 'number';
}

export function catalogFromArticleRecord(candidate: unknown): ArticleCatalog | null {
  if (!isArticleRecord(candidate)) {
    if (!candidate || typeof candidate !== 'object') return null;
    const flat = candidate as Record<string, unknown>;
    if (
      typeof flat.id === 'string'
      && typeof flat.title === 'string'
      && typeof flat.source === 'string'
      && typeof flat.sourceId === 'string'
      && typeof flat.publishedAt === 'string'
      && typeof flat.url === 'string'
    ) {
      return {
        id: flat.id,
        title: flat.title,
        source: flat.source,
        sourceId: flat.sourceId,
        publishedAt: flat.publishedAt,
        url: flat.url,
      };
    }
    return null;
  }
  const r = candidate;
  if (
    typeof r.title !== 'string'
    || typeof r.source !== 'string'
    || typeof r.sourceId !== 'string'
    || typeof r.publishedAt !== 'string'
    || typeof r.url !== 'string'
  ) return null;
  return {
    id: r.articleId,
    title: r.title,
    source: r.source,
    sourceId: r.sourceId,
    publishedAt: r.publishedAt,
    url: r.url,
  };
}

export function mergeCatalogIntoRecord(
  existing: ArticleRecord | null,
  catalog: ArticleCatalog,
): ArticleRecord {
  return {
    articleId: catalog.id,
    tags: existing?.tags ?? [],
    // Preserve existing updatedAt for catalog-only writes; tag writes set their own timestamp.
    updatedAt: existing?.updatedAt ?? Date.now(),
    title: catalog.title,
    source: catalog.source,
    sourceId: catalog.sourceId,
    publishedAt: catalog.publishedAt,
    url: catalog.url,
  };
}
