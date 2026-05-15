import type { Env } from '../../env';
import { DEFAULT_SOURCES } from '../rss/sources';
import { fetchFeedsStaggered } from '../rss/rssFetch';
import {
  articleMetaCacheKey,
  normalizeArticleMeta,
  wireArticleFromFeed,
  ARTICLE_META_TTL_SECONDS,
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
    const raw = await env.REC_STORE.get(articleMetaCacheKey(id), 'json');
    const meta = normalizeArticleMeta(raw);
    if (meta) out.set(id, meta);
  }));
  return out;
}

export async function persistArticleMeta(env: Env, entries: RecArticleMeta[]): Promise<void> {
  await Promise.all(entries.map(meta =>
    env.REC_STORE.put(articleMetaCacheKey(meta.id), JSON.stringify(meta), {
      expirationTtl: ARTICLE_META_TTL_SECONDS,
    }),
  ));
}

/** Synchronous miss fill: scan current RSS feeds and persist any matching ids. */
export async function hydrateArticleMetaFromFeeds(
  env: Env,
  missingIds: string[],
): Promise<Map<string, RecArticleMeta>> {
  const target = new Set(missingIds);
  if (target.size === 0) return new Map();

  const { articles } = await fetchFeedsStaggered(DEFAULT_SOURCES.filter(s => s.enabled));
  const resolved = new Map<string, RecArticleMeta>();
  for (const article of articles) {
    if (!target.has(article.id)) continue;
    resolved.set(article.id, wireArticleFromFeed(article));
  }
  if (resolved.size > 0) {
    await persistArticleMeta(env, Array.from(resolved.values()));
  }
  return resolved;
}

export async function lookupArticleMetaByIds(
  env: Env,
  ids: string[],
): Promise<RecArticlesResponse> {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const cached = await loadCachedArticleMeta(env, ids);
  const tKv = typeof performance !== 'undefined' ? performance.now() : Date.now();

  const missing = ids.filter(id => !cached.has(id));
  if (missing.length > 0) {
    const hydrated = await hydrateArticleMetaFromFeeds(env, missing);
    for (const [id, meta] of hydrated) cached.set(id, meta);
  }
  const tHydrate = typeof performance !== 'undefined' ? performance.now() : Date.now();

  const articles = ids
    .map(id => cached.get(id))
    .filter((v): v is RecArticleMeta => Boolean(v));

  const stillMissing = ids.filter(id => !cached.has(id));
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();

  return {
    ok: true,
    requested: ids.length,
    found: articles.length,
    missing: stillMissing,
    articles,
    timingMs: {
      kvLookup: tKv - t0,
      hydrate: tHydrate - tKv,
      total: t1 - t0,
    },
  };
}
