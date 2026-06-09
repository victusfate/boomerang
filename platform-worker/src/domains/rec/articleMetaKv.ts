/**
 * KV-only article metadata helpers — no RSS dependencies.
 * Isolated here so Node.js tests can import without the rss/* modules.
 */
import type { Env } from '../../env';
import {
  articleRecordKey,
  ARTICLE_RECORD_TTL_SECONDS,
  catalogFromArticleRecord,
  isArticleRecord,
  mergeCatalogIntoRecord,
} from '../meta/articleRecord.ts';
import {
  articleMetaCacheKey,
  normalizeArticleMeta,
  type RecArticleMeta,
  type RecArticlesResponse,
} from './articleMetaContract.ts';

// ── Isolate-level in-memory cache ─────────────────────────────────────────
// Shared within a V8 isolate's lifetime (~minutes under real load).
// Eliminates repeated KV reads for hot articles that appear in every bundle.
const MEM_CACHE_TTL_MS = 60 * 60 * 1000; // 1 h
const MEM_CACHE_MAX = 500;
type MemEntry = { meta: RecArticleMeta; at: number };
const metaMemCache = new Map<string, MemEntry>();

function memCacheGet(id: string): RecArticleMeta | null {
  const entry = metaMemCache.get(id);
  if (!entry) return null;
  if (Date.now() - entry.at > MEM_CACHE_TTL_MS) {
    metaMemCache.delete(id);
    return null;
  }
  return entry.meta;
}

function memCacheSet(id: string, meta: RecArticleMeta): void {
  metaMemCache.delete(id); // refresh insertion order on update
  if (metaMemCache.size >= MEM_CACHE_MAX) {
    const oldest = metaMemCache.keys().next().value;
    if (oldest !== undefined) metaMemCache.delete(oldest);
  }
  metaMemCache.set(id, { meta, at: Date.now() });
}

// ── KV operation counters ─────────────────────────────────────────────────
// Isolate-lifetime accumulators. Exposed via /rec/debug to monitor quota burn.
const _kv = { reads: 0, writes: 0, memHits: 0 };

export function getKvCounters(): { reads: number; writes: number; memHits: number } {
  return { ..._kv };
}

/** Only call from tests — clears isolate-level cache state. */
export function resetMemCacheForTest(): void { metaMemCache.clear(); }
/** Only call from tests — zeros KV counters. */
export function resetKvCountersForTest(): void { _kv.reads = 0; _kv.writes = 0; _kv.memHits = 0; }

// ─────────────────────────────────────────────────────────────────────────

/**
 * Above this many ids, skip the deprecated REC_STORE fallback: a worst-case
 * 500-id POST batch would otherwise issue up to 1000 KV reads and brush the
 * per-invocation subrequest cap before the hydrate path spends any budget.
 */
const LEGACY_FALLBACK_MAX_IDS = 250;

export async function loadCachedArticleMeta(env: Env, ids: string[]): Promise<Map<string, RecArticleMeta>> {
  const out = new Map<string, RecArticleMeta>();
  const skipLegacy = ids.length > LEGACY_FALLBACK_MAX_IDS;
  await Promise.all(ids.map(async (id) => {
    const fromMem = memCacheGet(id);
    if (fromMem) {
      _kv.memHits++;
      out.set(id, fromMem);
      return;
    }
    _kv.reads++;
    const kvRaw = await env.ARTICLE_META.get(articleRecordKey(id), 'json');
    const fromKv = catalogFromArticleRecord(kvRaw);
    if (fromKv) {
      memCacheSet(id, fromKv);
      out.set(id, fromKv);
      return;
    }
    if (skipLegacy) return;
    _kv.reads++;
    const legacyRaw = await env.REC_STORE.get(articleMetaCacheKey(id), 'json');
    const fromLegacy = normalizeArticleMeta(legacyRaw);
    if (fromLegacy) {
      memCacheSet(id, fromLegacy);
      out.set(id, fromLegacy);
    }
  }));
  return out;
}

export async function persistArticleMeta(env: Env, entries: RecArticleMeta[]): Promise<void> {
  if (entries.length === 0) return;
  await Promise.all(entries.map(async (catalog) => {
    const key = articleRecordKey(catalog.id);

    // Fast path: mem cache hit with identical fields — skip KV read+write entirely.
    const cached = memCacheGet(catalog.id);
    if (
      cached &&
      cached.title === catalog.title &&
      cached.source === catalog.source &&
      cached.sourceId === catalog.sourceId &&
      cached.publishedAt === catalog.publishedAt &&
      cached.url === catalog.url
    ) {
      _kv.memHits++;
      return;
    }

    _kv.reads++;
    const existing = await env.ARTICLE_META.get(key, 'json');
    const existingRecord = isArticleRecord(existing) ? existing : null;

    if (
      existingRecord &&
      existingRecord.title === catalog.title &&
      existingRecord.source === catalog.source &&
      existingRecord.sourceId === catalog.sourceId &&
      existingRecord.publishedAt === catalog.publishedAt &&
      existingRecord.url === catalog.url
    ) {
      memCacheSet(catalog.id, catalog); // warm cache from confirmed KV match
      return;
    }

    const record = mergeCatalogIntoRecord(existingRecord, catalog);
    _kv.writes++;
    await env.ARTICLE_META.put(key, JSON.stringify(record), {
      expirationTtl: ARTICLE_RECORD_TTL_SECONDS,
    });
    memCacheSet(catalog.id, catalog); // warm cache after write
  }));
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
