import type { Article, CustomSource, NewsSource } from '../types';
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

/**
 * Fetches enabled sources via the Worker (`GET /bundle?include=...`).
 * Text RSS and YouTube Atom feeds are requested in parallel as two bundle calls so each
 * Cloudflare Worker invocation stays under the per-invocation subrequest limit (~50).
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
  return fetchAllSourcesViaWorker(sources, customSources, onBatch);
}

async function fetchBundleJson(ids: string[], customSources: CustomSource[] = []): Promise<{
  articles: Array<Omit<Article, 'publishedAt' | 'score'> & { publishedAt: string }>;
}> {
  const qs = ids.join(',');
  let url = `${RSS_WORKER_URL}/bundle?include=${encodeURIComponent(qs)}`;
  if (customSources.length > 0) {
    const payload = customSources.map(s => ({ id: s.id, name: s.name, feedUrl: s.feedUrl }));
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    let binary = '';
    bytes.forEach(b => { binary += String.fromCharCode(b); });
    url += `&customFeeds=${encodeURIComponent(btoa(binary))}`;
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    throw new Error(`Feed service returned ${res.status}`);
  }
  return res.json();
}

function mapBundleArticles(
  data: Array<Omit<Article, 'publishedAt' | 'score'> & { publishedAt: string }>,
): Article[] {
  return data.map(a => ({
    ...a,
    publishedAt: new Date(a.publishedAt),
  }));
}

async function fetchAllSourcesViaWorker(
  sources: NewsSource[],
  customSources: CustomSource[],
  onBatch?: (articles: Article[]) => void,
): Promise<Article[]> {
  if (sources.length === 0 && customSources.length === 0) return [];

  const ytIds    = sources.filter(s =>  isYoutubeSourceId(s.id)).map(s => s.id);
  const nonYtIds = sources.filter(s => !isYoutubeSourceId(s.id)).map(s => s.id);
  // Custom sources go with the non-YT bundle call to avoid a third round-trip
  const needsNonYtCall = nonYtIds.length > 0 || customSources.length > 0;

  let raw: Array<Omit<Article, 'publishedAt' | 'score'> & { publishedAt: string }>;

  if (!needsNonYtCall) {
    raw = (await fetchBundleJson(ytIds)).articles;
  } else if (ytIds.length === 0) {
    raw = (await fetchBundleJson(nonYtIds, customSources)).articles;
  } else {
    const [nonYtData, ytData] = await Promise.all([
      fetchBundleJson(nonYtIds, customSources),
      fetchBundleJson(ytIds),
    ]);
    raw = [...nonYtData.articles, ...ytData.articles];
  }

  const articles = mapBundleArticles(raw);
  if (articles.length > 0) {
    onBatch?.(articles);
  }
  return articles;
}
