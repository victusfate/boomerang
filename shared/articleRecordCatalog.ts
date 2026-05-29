/**
 * Canonical ARTICLE_META KV catalog TTL constants and helpers.
 * Shared verbatim between `platform-worker` and the `news-feed` UI.
 * @module shared/articleRecordCatalog
 * @category Shared
 */

const DAY_SECONDS = 24 * 60 * 60;

/** ~6 months (180 days); each KV put refreshes expiry from this value. */
export const ARTICLE_RECORD_TTL_SECONDS = 180 * DAY_SECONDS;

/** Human label for UI copy, derived from {@link ARTICLE_RECORD_TTL_SECONDS}. */
export function formatArticleCatalogCacheLabel(
  ttlSeconds: number = ARTICLE_RECORD_TTL_SECONDS,
): string {
  const days = Math.round(ttlSeconds / DAY_SECONDS);
  if (days >= 28) {
    const months = Math.round(days / 30);
    return months === 1 ? '1 month' : `${months} months`;
  }
  if (days >= 7) {
    const weeks = Math.round(days / 7);
    return weeks === 1 ? '1 week' : `${weeks} weeks`;
  }
  return days === 1 ? '1 day' : `${days} days`;
}

/** Placeholder title shown when an article's metadata is outside the KV cache window. */
export function articleCatalogMissingTitleLabel(
  ttlSeconds: number = ARTICLE_RECORD_TTL_SECONDS,
): string {
  return `(article metadata outside of cache ${formatArticleCatalogCacheLabel(ttlSeconds)})`;
}
