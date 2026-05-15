import type { Env } from '../../env';
import { DEFAULT_SOURCES } from '../rss/sources';
import { fetchFeedsStaggered } from '../rss/rssFetch';
import type { ArticleWire } from '../rss/parseFeed';
import {
  articleRecordKey,
  ARTICLE_RECORD_TTL_SECONDS,
  catalogFromArticleRecord,
  isArticleRecord,
  mergeCatalogIntoRecord,
} from '../meta/articleRecord';
import {
  articleMetaCacheKey,
  normalizeArticleMeta,
  wireArticleFromFeed,
  type RecArticleMeta,
  type RecArticlesResponse,
} from './articleMetaContract';

export {
  ARTICLE_META_KEY_PREFIX,
  ARTICLE_META_TTL_SECONDS,
  MAX_ARTICLE_IDS_LOOKUP,
  articleMetaCacheKey,
  normalizeIdsParam,
  normalizeArticleMeta,
  wireArticleFromFeed,
} from './articleMetaContract';
export type { RecArticleMeta, RecArticlesResponse } from './articleMetaContract';

export async function loadCachedArticleMeta(env: Env, ids: string[]): Promise<Map<string, RecArticleMeta>> {
  const out = new Map<string, RecArticleMeta>();
  await Promise.all(ids.map(async (id) => {
    const kvRaw = await env.ARTICLE_META.get(articleRecordKey(id), 'json');
    const fromKv = catalogFromArticleRecord(kvRaw);
    if (fromKv) {
      out.set(id, fromKv);
      return;
    }
    const legacyRaw = await env.REC_STORE.get(articleMetaCacheKey(id), 'json');
    const fromLegacy = normalizeArticleMeta(legacyRaw);
    if (fromLegacy) out.set(id, fromLegacy);
  }));
  return out;
}

export async function persistArticleMeta(env: Env, entries: RecArticleMeta[]): Promise<void> {
  if (entries.length === 0) return;
  await Promise.all(entries.map(async (catalog) => {
    const key = articleRecordKey(catalog.id);
    const existing = await env.ARTICLE_META.get(key, 'json');
    const record = mergeCatalogIntoRecord(
      isArticleRecord(existing) ? existing : null,
      catalog,
    );
    await env.ARTICLE_META.put(key, JSON.stringify(record), {
      expirationTtl: ARTICLE_RECORD_TTL_SECONDS,
    });
  }));
}

function resolveFromArticlePool(
  pool: ArticleWire[],
  target: Set<string>,
): Map<string, RecArticleMeta> {
  const resolved = new Map<string, RecArticleMeta>();
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
): Promise<Map<string, RecArticleMeta>> {
  const target = new Set(missingIds);
  if (target.size === 0) return new Map();

  const resolved = new Map<string, RecArticleMeta>();

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

/** Fast KV lookup only — never blocks on RSS. */
export async function lookupArticleMetaByIds(
  env: Env,
  ids: string[],
): Promise<RecArticlesResponse> {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const cached = await loadCachedArticleMeta(env, ids);
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();

  const articles = ids
    .map(id => cached.get(id))
    .filter((v): v is RecArticleMeta => Boolean(v));

  const stillMissing = ids.filter(id => !cached.has(id));

  return {
    ok: true,
    requested: ids.length,
    found: articles.length,
    missing: stillMissing,
    articles,
    timingMs: {
      kvLookup: t1 - t0,
      hydrate: 0,
      total: t1 - t0,
    },
  };
}

export function defaultBundleCacheRequest(request: Request): Request {
  return new Request(new URL('/bundle', request.url).toString(), { method: 'GET' });
}
