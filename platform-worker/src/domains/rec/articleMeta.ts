import type { Env } from '../../env';
import { DEFAULT_SOURCES } from '../rss/sources';
import { fetchFeedsStaggered } from '../rss/rssFetch';
import type { ArticleWire } from '../rss/parseFeed';
import { wireArticleFromFeed } from './articleMetaContract';
import { persistArticleMeta } from './articleMetaKv';

export {
  ARTICLE_META_KEY_PREFIX,
  ARTICLE_META_TTL_SECONDS,
  MAX_ARTICLE_IDS_LOOKUP,
  MAX_ARTICLE_IDS_LOOKUP_POST,
  articleMetaCacheKey,
  normalizeIdsParam,
  normalizeIdsBody,
  normalizeArticleMeta,
  wireArticleFromFeed,
} from './articleMetaContract';
export type { RecArticleMeta, RecArticlesResponse } from './articleMetaContract';

export {
  loadCachedArticleMeta,
  persistArticleMeta,
  lookupArticleMetaByIds,
  defaultBundleCacheRequest,
  getKvCounters,
  resetMemCacheForTest,
  resetKvCountersForTest,
} from './articleMetaKv';

function resolveFromArticlePool(
  pool: ArticleWire[],
  target: Set<string>,
): Map<string, ReturnType<typeof wireArticleFromFeed>> {
  const resolved = new Map<string, ReturnType<typeof wireArticleFromFeed>>();
  for (const article of pool) {
    if (!target.has(article.id)) continue;
    resolved.set(article.id, wireArticleFromFeed(article));
    target.delete(article.id);
  }
  return resolved;
}

/** Background miss fill: prefer recent /bundle cache, then RSS fetch for remainder. */
export async function hydrateArticleMetaFromFeeds(
  env: Env,
  missingIds: string[],
  bundleCacheRequest?: Request,
): Promise<Map<string, ReturnType<typeof wireArticleFromFeed>>> {
  const target = new Set(missingIds);
  if (target.size === 0) return new Map();

  const resolved = new Map<string, ReturnType<typeof wireArticleFromFeed>>();

  if (bundleCacheRequest) {
    try {
      const cached = await caches.default.match(bundleCacheRequest);
      if (cached) {
        const body = await cached.json() as { articles?: ArticleWire[] };
        if (Array.isArray(body.articles)) {
          for (const [id, meta] of resolveFromArticlePool(body.articles, target)) {
            resolved.set(id, meta);
          }
        }
      }
    } catch {
      /* ignore cache read errors */
    }
  }

  if (target.size > 0) {
    const { articles } = await fetchFeedsStaggered(DEFAULT_SOURCES.filter(s => s.enabled));
    for (const [id, meta] of resolveFromArticlePool(articles, target)) {
      resolved.set(id, meta);
    }
  }

  if (resolved.size > 0) {
    await persistArticleMeta(env, Array.from(resolved.values()));
  }
  return resolved;
}
