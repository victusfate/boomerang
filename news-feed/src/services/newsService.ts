import type { Article, CustomSource, NewsSource } from '../types';
import { partitionSourcesForSplitFetch } from './feedPartition';
import rssSourcesJson from '../../../shared/rss-sources.json';

/**
 * Production default — same Worker the repo deploys (`rss-worker/wrangler.jsonc` name + account subdomain).
 * Set `VITE_RSS_WORKER_URL` at build time to override (e.g. GitHub Actions variable).
 * Without this fallback, a missing env yields an empty string and no `/bundle` requests are made.
 */
const DEFAULT_RSS_WORKER_URL = 'https://boomerang-rss.boomerang.workers.dev';

const envWorker = import.meta.env.VITE_RSS_WORKER_URL?.replace(/\/$/, '') ?? '';
const RSS_WORKER_URL =
  envWorker || (import.meta.env.PROD ? DEFAULT_RSS_WORKER_URL : '');

// Built-in sources: single source of truth in `shared/rss-sources.json` (priority 1 = first batch; 2 = background).
export const DEFAULT_SOURCES: NewsSource[] = rssSourcesJson as NewsSource[];

export { partitionSourcesForSplitFetch };

function mapBundleArticles(
  data: Array<Omit<Article, 'publishedAt' | 'score'> & { publishedAt: string }>,
): Article[] {
  return data.map(a => ({
    ...a,
    publishedAt: new Date(a.publishedAt),
  }));
}

function tagFetchTier(articles: Article[], tier: 'fast' | 'background'): Article[] {
  return articles.map(a => ({ ...a, fetchTier: tier }));
}

const MISSING_WORKER_MSG =
  'RSS is served only via the Cloudflare Worker. Set VITE_RSS_WORKER_URL (e.g. https://boomerang-rss.boomerang.workers.dev or http://127.0.0.1:8787 for wrangler dev) and rebuild.';

/** Worker origin (bundle + `/og-image`). Throws if env is unset — same as `fetchAllSources`. */
export function getRssWorkerBaseUrl(): string {
  if (!RSS_WORKER_URL) throw new Error(MISSING_WORKER_MSG);
  return RSS_WORKER_URL;
}

function isYoutubeSourceId(id: string): boolean {
  return id.startsWith('yt-');
}

/** Stay under Cloudflare Worker per-invocation subrequest limit (~50); margin for safety. */
const MAX_FEEDS_PER_BUNDLE = 46;
/**
 * When `customFeeds` is base64 in the query string, large chunks create huge URLs.
 * Use smaller pages only for queues that include custom feeds; built-in-only URLs stay compact (`include=id,…`).
 */
const MAX_WORK_ITEMS_WHEN_CUSTOM = 20;

/** Worker: empty built-in list — must not send bare `include=` (that means “all defaults” on the server). */
const INCLUDE_NONE_SENTINEL = '__none__';

/** Worker staggers many RSS fetches; a single /bundle can take well over 30s. Keep below browser limits (~2–5 min). */
const BUNDLE_FETCH_TIMEOUT_MIN_MS = 30_000;
const BUNDLE_FETCH_TIMEOUT_MAX_MS = 180_000;
const BUNDLE_FETCH_TIMEOUT_BASE_MS = 20_000;
const BUNDLE_FETCH_TIMEOUT_PER_FEED_MS = 2_500;

function bundleFetchTimeoutMs(ids: string[], customSources: CustomSource[]): number {
  const n = ids.length + customSources.length;
  const raw = BUNDLE_FETCH_TIMEOUT_BASE_MS + n * BUNDLE_FETCH_TIMEOUT_PER_FEED_MS;
  return Math.min(BUNDLE_FETCH_TIMEOUT_MAX_MS, Math.max(BUNDLE_FETCH_TIMEOUT_MIN_MS, raw));
}

function compareFeedUrlLocale(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

function sourceByIdMap(sources: NewsSource[]): Map<string, NewsSource> {
  return new Map(sources.map(s => [s.id, s]));
}

/** Stable order for `/bundle` query keys and JSON payloads (cache-friendly). */
function sortCustomSourcesByFeedUrl(customs: CustomSource[]): CustomSource[] {
  return [...customs].sort((a, b) => {
    const c = compareFeedUrlLocale(a.feedUrl, b.feedUrl);
    return c !== 0 ? c : a.id.localeCompare(b.id);
  });
}

function sortIncludeIdsByFeedUrl(ids: string[], sources: NewsSource[]): string[] {
  const byId = sourceByIdMap(sources);
  return [...ids].sort((a, b) => {
    const ua = byId.get(a)?.feedUrl ?? a;
    const ub = byId.get(b)?.feedUrl ?? b;
    const c = compareFeedUrlLocale(ua, ub);
    return c !== 0 ? c : a.localeCompare(b);
  });
}

type NonYtWorkItem =
  | { kind: 'custom'; source: CustomSource }
  | { kind: 'builtin'; id: string };

/** Single ordering by feed URL so batch boundaries and cache keys are stable regardless of import order. */
function buildSortedNonYtWorkQueue(
  nonYtIds: string[],
  customs: CustomSource[],
  sources: NewsSource[],
): NonYtWorkItem[] {
  const byId = sourceByIdMap(sources);
  const items: NonYtWorkItem[] = [
    ...customs.map(s => ({ kind: 'custom' as const, source: s })),
    ...nonYtIds.map(id => ({ kind: 'builtin' as const, id })),
  ];
  items.sort((a, b) => {
    const ua = a.kind === 'custom' ? a.source.feedUrl : (byId.get(a.id)?.feedUrl ?? a.id);
    const ub = b.kind === 'custom' ? b.source.feedUrl : (byId.get(b.id)?.feedUrl ?? b.id);
    const c = compareFeedUrlLocale(ua, ub);
    if (c !== 0) return c;
    const ida = a.kind === 'custom' ? a.source.id : a.id;
    const idb = b.kind === 'custom' ? b.source.id : b.id;
    return ida.localeCompare(idb);
  });
  return items;
}

function chunkWorkQueue<T>(items: T[], maxPerChunk: number): T[][] {
  if (items.length === 0) return [];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += maxPerChunk) {
    chunks.push(items.slice(i, i + maxPerChunk));
  }
  return chunks;
}

function nonYtChunkToParams(chunk: NonYtWorkItem[]): { ids: string[]; customSources: CustomSource[] } {
  const ids: string[] = [];
  const customSources: CustomSource[] = [];
  for (const item of chunk) {
    if (item.kind === 'builtin') ids.push(item.id);
    else customSources.push(item.source);
  }
  return { ids, customSources };
}

function chunkIds(ids: string[], maxPerChunk: number): string[][] {
  return chunkWorkQueue(ids, maxPerChunk);
}

/**
 * Fetches enabled sources via the Worker (`GET /bundle?include=...`).
 * Non–YouTube work (custom + built-in) and YouTube feeds are ordered by feed URL for stable
 * batching/cache keys, then split into pages of at most `MAX_FEEDS_PER_BUNDLE` (or smaller when
 * `customFeeds` is present) so each Worker invocation stays under ~50 subrequests.
 * `onBatch` is called with cumulative articles after each page (progressive load).
 * No browser-side RSS or CORS-proxy fallback — misconfigured builds fail fast.
 */
export async function fetchAllSources(
  sources: NewsSource[],
  customSources: CustomSource[],
  onBatch?: (articles: Article[]) => void,
): Promise<Article[]> {
  if (!RSS_WORKER_URL) {
    throw new Error(MISSING_WORKER_MSG);
  }
  if (sources.length === 0 && customSources.length === 0) return [];
  return fetchAllSourcesSplit(sources, customSources, onBatch);
}

async function fetchBundleJson(
  ids: string[],
  customSources: CustomSource[] = [],
  sources?: NewsSource[],
): Promise<{
  articles: Array<Omit<Article, 'publishedAt' | 'score'> & { publishedAt: string }>;
}> {
  const idsOrdered =
    ids.length > 0
      ? sources
        ? sortIncludeIdsByFeedUrl(ids, sources)
        : [...ids].sort((a, b) => a.localeCompare(b))
      : ids;
  const customOrdered = sortCustomSourcesByFeedUrl(customSources);
  const qs = idsOrdered.length > 0 ? idsOrdered.join(',') : INCLUDE_NONE_SENTINEL;
  let url = `${RSS_WORKER_URL}/bundle?include=${encodeURIComponent(qs)}`;
  if (customOrdered.length > 0) {
    const payload = customOrdered.map(s => ({ id: s.id, name: s.name, feedUrl: s.feedUrl }));
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    let binary = '';
    bytes.forEach(b => { binary += String.fromCharCode(b); });
    url += `&customFeeds=${encodeURIComponent(btoa(binary))}`;
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(bundleFetchTimeoutMs(idsOrdered, customOrdered)) });
  if (!res.ok) {
    throw new Error(`Feed service returned ${res.status}`);
  }
  return res.json();
}

/**
 * Fetches a subset of the catalog (one staggered pass: non-YouTube + YouTube) without tier tags.
 * Used for fast (priority-1) and background (priority-2 + custom) in parallel.
 */
async function loadArticlesFromWorker(
  sources: NewsSource[],
  customSources: CustomSource[],
  onProgress?: (cumulative: Article[]) => void,
): Promise<Article[]> {
  if (sources.length === 0 && customSources.length === 0) return [];

  const ytIds = sources.filter(s => isYoutubeSourceId(s.id)).map(s => s.id);
  const nonYtIds = sources.filter(s => !isYoutubeSourceId(s.id)).map(s => s.id);
  const needsNonYtCall = nonYtIds.length > 0 || customSources.length > 0;

  type Wire = Omit<Article, 'publishedAt' | 'score'> & { publishedAt: string };
  let nonYtWire: Wire[] = [];
  let ytWire: Wire[] = [];

  if (needsNonYtCall) {
    const queue = buildSortedNonYtWorkQueue(nonYtIds, customSources, sources);
    const maxPerChunk =
      customSources.length > 0 ? MAX_WORK_ITEMS_WHEN_CUSTOM : MAX_FEEDS_PER_BUNDLE;
    const chunks = chunkWorkQueue(queue, maxPerChunk);
    for (const chunk of chunks) {
      const { ids, customSources: cs } = nonYtChunkToParams(chunk);
      const data = await fetchBundleJson(ids, cs, sources);
      nonYtWire.push(...data.articles);
      const merged = mapBundleArticles([...nonYtWire, ...ytWire]);
      onProgress?.(merged);
      await new Promise<void>(r => queueMicrotask(r));
    }
  }

  if (ytIds.length > 0) {
    const ytIdsSorted = sortIncludeIdsByFeedUrl(ytIds, sources);
    const ytChunks = chunkIds(ytIdsSorted, MAX_FEEDS_PER_BUNDLE);
    for (const idChunk of ytChunks) {
      const data = await fetchBundleJson(idChunk, [], sources);
      ytWire.push(...data.articles);
      const merged = mapBundleArticles([...nonYtWire, ...ytWire]);
      onProgress?.(merged);
      await new Promise<void>(r => queueMicrotask(r));
    }
  }

  return mapBundleArticles([...nonYtWire, ...ytWire]);
}

/**
 * Splits by `priority` (1 = fast, 2 = background), custom OPML only on background, runs both
 * fetches in parallel, tags `fetchTier` on every article, and calls `onBatch` with the merged
 * pool whenever either side advances (progressive load).
 */
async function fetchAllSourcesSplit(
  activeSources: NewsSource[],
  customSources: CustomSource[],
  onBatch?: (articles: Article[]) => void,
): Promise<Article[]> {
  const { fast, background } = partitionSourcesForSplitFetch(activeSources, customSources);
  const fastS = fast.sources;
  const bgS = background.sources;
  const bgCustom = background.custom;

  let fastAcc: Article[] = [];
  let bgAcc: Article[] = [];
  const emit = () => {
    onBatch?.([...tagFetchTier(fastAcc, 'fast'), ...tagFetchTier(bgAcc, 'background')]);
  };

  const onlyFast = fastS.length > 0 && bgS.length === 0 && bgCustom.length === 0;
  const onlyBg   = fastS.length === 0 && (bgS.length > 0 || bgCustom.length > 0);

  if (onlyFast) {
    const acc = await loadArticlesFromWorker(fastS, [], (a) => {
      fastAcc = a;
      emit();
    });
    return tagFetchTier(acc, 'fast');
  }
  if (onlyBg) {
    const acc = await loadArticlesFromWorker(bgS, bgCustom, (a) => {
      bgAcc = a;
      emit();
    });
    return tagFetchTier(acc, 'background');
  }

  await Promise.all([
    loadArticlesFromWorker(fastS, [], (acc) => {
      fastAcc = acc;
      emit();
    }),
    loadArticlesFromWorker(bgS, bgCustom, (acc) => {
      bgAcc = acc;
      emit();
    }),
  ]);
  return [...tagFetchTier(fastAcc, 'fast'), ...tagFetchTier(bgAcc, 'background')];
}
