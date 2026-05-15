/**
 * Client parsing for GET /rec/articles (no worker fetch / kv deps).
 * RecArticleMeta and RecArticlesResponse intentionally mirror the types in
 * `platform-worker/src/domains/rec/articleMetaContract.ts` — kept separate
 * to avoid bundling worker code into the client. Keep both in sync when fields change.
 */

export interface RecArticleMeta {
  id: string;
  title: string;
  source: string;
  sourceId: string;
  publishedAt: string;
  url: string;
}

export interface RecArticlesLookupTiming {
  kvLookup: number;
  hydrate: number;
  total: number;
}

export interface RecArticlesResponse {
  ok: true;
  requested: number;
  found: number;
  missing: string[];
  articles: RecArticleMeta[];
  timingMs?: RecArticlesLookupTiming;
}

export function normalizeRecArticleMeta(candidate: unknown): RecArticleMeta | null {
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

export function parseRecArticlesResponse(body: unknown): RecArticlesResponse {
  const raw = (body && typeof body === 'object') ? body as Record<string, unknown> : {};
  const articles = Array.isArray(raw.articles)
    ? raw.articles.reduce<RecArticleMeta[]>((acc, row) => {
      const meta = normalizeRecArticleMeta(row);
      if (meta) acc.push(meta);
      return acc;
    }, [])
    : [];
  const missing = Array.isArray(raw.missing)
    ? raw.missing.filter((id): id is string => typeof id === 'string')
    : [];
  const requested = typeof raw.requested === 'number' ? raw.requested : articles.length + missing.length;
  const found = typeof raw.found === 'number' ? raw.found : articles.length;
  const timingRaw = raw.timingMs;
  const timingMs = (timingRaw && typeof timingRaw === 'object')
    ? (() => {
      const t = timingRaw as Record<string, unknown>;
      if (
        typeof t.kvLookup !== 'number'
        || typeof t.hydrate !== 'number'
        || typeof t.total !== 'number'
      ) return undefined;
      return { kvLookup: t.kvLookup, hydrate: t.hydrate, total: t.total };
    })()
    : undefined;
  return { ok: true, requested, found, missing, articles, timingMs };
}
