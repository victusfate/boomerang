import type { Article, NewsSource } from '../types';

/** Set at build time to Cloudflare Worker origin (e.g. https://boomerang-rss.xxx.workers.dev) */
const RSS_WORKER_URL = import.meta.env.VITE_RSS_WORKER_URL?.replace(/\/$/, '') ?? '';

// Sources are split into two tiers:
//   priority=1  fast/reliable feeds that render first (visible within ~2 s)
//   priority=2  supplemental feeds loaded in the background batch
export const DEFAULT_SOURCES: NewsSource[] = [
  // ── Tier-1: fast / high-signal text sources ──────────────────────────────────
  { id: 'hn',        name: 'Hacker News',        feedUrl: 'https://news.ycombinator.com/rss',                         category: 'technology',    enabled: true,  priority: 1 },
  { id: 'bbc',       name: 'BBC News',            feedUrl: 'https://feeds.bbci.co.uk/news/rss.xml',                    category: 'world',         enabled: true,  priority: 1 },
  { id: 'guardian',  name: 'The Guardian',        feedUrl: 'https://www.theguardian.com/world/rss',                    category: 'world',         enabled: true,  priority: 1 },
  { id: 'ars',       name: 'Ars Technica',        feedUrl: 'https://feeds.arstechnica.com/arstechnica/index',          category: 'technology',    enabled: true,  priority: 1 },
  { id: 'npm',       name: 'NPR News',            feedUrl: 'https://feeds.npr.org/1001/rss.xml',                       category: 'world',         enabled: true,  priority: 1 },
  { id: 'reuters',   name: 'Reuters',             feedUrl: 'https://feeds.reuters.com/reuters/topNews',                category: 'world',         enabled: true,  priority: 1 },
  { id: 'sciam',     name: 'Scientific American', feedUrl: 'https://rss.sciam.com/ScientificAmerican-Global',          category: 'science',       enabled: true,  priority: 1 },
  { id: 'verge',     name: 'The Verge',           feedUrl: 'https://www.theverge.com/rss/index.xml',                   category: 'technology',    enabled: true,  priority: 1 },

  // ── Tier-2: supplemental text sources ────────────────────────────────────────
  { id: 'mit',       name: 'MIT Tech Review',     feedUrl: 'https://www.technologyreview.com/feed/',                   category: 'technology',    enabled: true,  priority: 2 },
  { id: 'wired',     name: 'Wired',               feedUrl: 'https://www.wired.com/feed/rss',                           category: 'technology',    enabled: true,  priority: 2 },
  { id: 'tc',        name: 'TechCrunch',          feedUrl: 'https://techcrunch.com/feed/',                             category: 'technology',    enabled: true,  priority: 2 },
  { id: 'aje',       name: 'Al Jazeera',          feedUrl: 'https://www.aljazeera.com/xml/rss/all.xml',                category: 'world',         enabled: true,  priority: 2 },
  { id: 'physorg',   name: 'Phys.org',            feedUrl: 'https://phys.org/rss-feed/',                               category: 'science',       enabled: true,  priority: 2 },
  { id: 'nature',    name: 'Nature',              feedUrl: 'https://www.nature.com/nature/current_issue/rss',          category: 'science',       enabled: true,  priority: 2 },
  { id: 'nasa',      name: 'NASA',                feedUrl: 'https://www.nasa.gov/rss/dyn/breaking_news.rss',           category: 'science',       enabled: true,  priority: 2 },
  { id: 'newscient', name: 'New Scientist',       feedUrl: 'https://www.newscientist.com/feed/home/',                  category: 'science',       enabled: true,  priority: 2 },
  { id: 'quartz',    name: 'Quartz',              feedUrl: 'https://qz.com/feed',                                      category: 'business',      enabled: true,  priority: 2 },
  { id: 'economist', name: 'The Economist',       feedUrl: 'https://www.economist.com/latest/rss.xml',                 category: 'business',      enabled: true,  priority: 2 },
  { id: 'espn',      name: 'ESPN',                feedUrl: 'https://www.espn.com/espn/rss/news',                       category: 'sports',        enabled: true,  priority: 2 },
  { id: 'variety',   name: 'Variety',             feedUrl: 'https://variety.com/feed/',                                category: 'entertainment', enabled: true,  priority: 2 },
  { id: 'pitchfork', name: 'Pitchfork',           feedUrl: 'https://pitchfork.com/rss/news/feed.xml',                  category: 'entertainment', enabled: true,  priority: 2 },
  { id: 'devto',     name: 'Dev.to',              feedUrl: 'https://dev.to/feed',                                      category: 'technology',    enabled: true,  priority: 2 },
  { id: 'smash',     name: 'Smashing Magazine',   feedUrl: 'https://www.smashingmagazine.com/feed/',                   category: 'technology',    enabled: true,  priority: 2 },
  { id: 'yale360',   name: 'Yale Env. 360',       feedUrl: 'https://e360.yale.edu/feed',                               category: 'environment',   enabled: true,  priority: 2 },
  { id: 'carbonbrf', name: 'Carbon Brief',        feedUrl: 'https://www.carbonbrief.org/feed',                         category: 'environment',   enabled: true,  priority: 2 },
  // New tier-2 text sources
  { id: 'ap',        name: 'AP News',             feedUrl: 'https://rsshub.app/apnews/topics/apf-topnews',             category: 'world',         enabled: true,  priority: 2 },
  { id: 'engadget',  name: 'Engadget',            feedUrl: 'https://www.engadget.com/rss.xml',                         category: 'technology',    enabled: true,  priority: 2 },
  { id: 'ieee',      name: 'IEEE Spectrum',       feedUrl: 'https://spectrum.ieee.org/feeds/feed.rss',                 category: 'technology',    enabled: true,  priority: 2 },
  { id: 'popsci',    name: 'Popular Science',     feedUrl: 'https://www.popsci.com/feed/',                             category: 'science',       enabled: true,  priority: 2 },
  { id: 'scidaily',  name: 'Science Daily',       feedUrl: 'https://www.sciencedaily.com/rss/top/science.xml',         category: 'science',       enabled: true,  priority: 2 },
  { id: 'grist',     name: 'Grist',               feedUrl: 'https://grist.org/feed/',                                  category: 'environment',   enabled: true,  priority: 2 },
  { id: 'icn',       name: 'Inside Climate News', feedUrl: 'https://insideclimatenews.org/feed/',                      category: 'environment',   enabled: true,  priority: 2 },

  // ── YouTube channels (Atom feeds with auto-extracted thumbnails) ─────────────
  { id: 'yt-kurzgesagt', name: 'Kurzgesagt',       feedUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCsXVk37bltHxD1rDPwtNM8Q', category: 'science',    enabled: true,  priority: 2 },
  { id: 'yt-veritasium', name: 'Veritasium',       feedUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCHnyfMqiRRG1u-2MsSQLbXA', category: 'science',    enabled: true,  priority: 2 },
  { id: 'yt-3b1b',       name: '3Blue1Brown',      feedUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCYO_jab_esuFRV4b17AJtAw', category: 'science',    enabled: true,  priority: 2 },
  { id: 'yt-ted',        name: 'TED',              feedUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCAuUUnT6oDeKwE6v1NGQxug', category: 'general',    enabled: true,  priority: 2 },
  { id: 'yt-mkbhd',      name: 'MKBHD',            feedUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCBJycsmduvYEL83R_U4JriQ', category: 'technology', enabled: true,  priority: 2 },
  { id: 'yt-smarter',    name: 'SmarterEveryDay',  feedUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UC6107grRI4m0o2-emgoDnAA', category: 'science',    enabled: true,  priority: 2 },
  { id: 'yt-numberph',   name: 'Numberphile',      feedUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCoxcjq-8xIDTYp3uz647V5A', category: 'science',    enabled: true,  priority: 2 },
  { id: 'yt-tomscott',   name: 'Tom Scott',        feedUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCBa659QWEk1AI4Tg--mrJ2A', category: 'general',    enabled: false, priority: 2 },
  { id: 'yt-ltt',        name: 'Linus Tech Tips',  feedUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCXuqSBlHAE6Xw-yeJA0Tunw', category: 'technology', enabled: false, priority: 2 },
  { id: 'yt-wendover',   name: 'Wendover Prod.',   feedUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UC9RM-iSzvit8LxFzbkUsEyQ', category: 'general',    enabled: false, priority: 2 },
  { id: 'yt-realeng',    name: 'Real Engineering',  feedUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCR1IuLEqb6UEA_zQ81kwXfg', category: 'science',   enabled: false, priority: 2 },
  { id: 'yt-dw',         name: 'DW News',           feedUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCknLrEdhRCp1aegoMqRaCZg', category: 'world',     enabled: false, priority: 2 },
  { id: 'yt-pbs',        name: 'PBS NewsHour',      feedUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UC6ZFN9Tx6xh-skXa_NZk5eA', category: 'world',     enabled: false, priority: 2 },
];

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
  onBatch?: (articles: Article[]) => void,
): Promise<Article[]> {
  if (!RSS_WORKER_URL) {
    throw new Error(MISSING_WORKER_MSG);
  }
  return fetchAllSourcesViaWorker(sources, onBatch);
}

async function fetchBundleJson(ids: string[]): Promise<{
  articles: Array<Omit<Article, 'publishedAt' | 'score'> & { publishedAt: string }>;
}> {
  const qs = ids.join(',');
  const url = `${RSS_WORKER_URL}/bundle?include=${encodeURIComponent(qs)}`;
  const res = await fetch(url);
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
  onBatch?: (articles: Article[]) => void,
): Promise<Article[]> {
  if (sources.length === 0) return [];

  const ytIds = sources.filter(s => isYoutubeSourceId(s.id)).map(s => s.id);
  const nonYtIds = sources.filter(s => !isYoutubeSourceId(s.id)).map(s => s.id);

  let raw: Array<Omit<Article, 'publishedAt' | 'score'> & { publishedAt: string }>;

  if (ytIds.length === 0) {
    raw = (await fetchBundleJson(nonYtIds)).articles;
  } else if (nonYtIds.length === 0) {
    raw = (await fetchBundleJson(ytIds)).articles;
  } else {
    const [nonYtData, ytData] = await Promise.all([
      fetchBundleJson(nonYtIds),
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
