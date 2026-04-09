import type { Article, NewsSource, Topic } from '../types';

// Two CORS proxies — race them in parallel; first valid response wins
const PROXY_PRIMARY  = (url: string) => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
const PROXY_FALLBACK = (url: string) => `https://corsproxy.io/?${encodeURIComponent(url)}`;

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

const TOPIC_KEYWORDS: Record<Topic, string[]> = {
  technology:   ['tech', 'software', 'ai', 'artificial intelligence', 'startup', 'computer', 'app', 'digital', 'cyber', 'robot', 'algorithm', 'data', 'cloud', 'code', 'developer', 'open source', 'programming', 'silicon', 'apple', 'google', 'microsoft', 'openai', 'llm', 'model'],
  science:      ['science', 'research', 'study', 'scientists', 'discovery', 'space', 'nasa', 'biology', 'physics', 'chemistry', 'genome', 'dna', 'evolution', 'universe', 'quantum', 'experiment'],
  world:        ['war', 'election', 'government', 'president', 'country', 'international', 'global', 'politics', 'diplomatic', 'treaty', 'sanctions', 'military', 'conflict', 'nato', 'un', 'china', 'russia', 'europe'],
  business:     ['economy', 'market', 'stock', 'financial', 'business', 'trade', 'bank', 'investment', 'gdp', 'inflation', 'revenue', 'profit', 'merger', 'acquisition', 'ipo', 'venture', 'funding'],
  health:       ['health', 'medical', 'vaccine', 'disease', 'hospital', 'doctor', 'treatment', 'cancer', 'mental health', 'drug', 'clinical', 'patient', 'fda', 'cdc', 'pandemic'],
  environment:  ['climate', 'environment', 'carbon', 'emissions', 'renewable', 'solar', 'wind', 'fossil fuel', 'biodiversity', 'ocean', 'deforestation', 'sustainability', 'green'],
  sports:       ['sports', 'football', 'basketball', 'baseball', 'soccer', 'tennis', 'nba', 'nfl', 'olympic', 'championship', 'tournament', 'athlete', 'league', 'fifa'],
  entertainment:['movie', 'film', 'music', 'album', 'celebrity', 'award', 'oscar', 'grammy', 'streaming', 'netflix', 'disney', 'hollywood', 'concert', 'box office'],
  general:      [],
};

function detectTopics(text: string): Topic[] {
  const lower = text.toLowerCase();
  const matched: Topic[] = [];
  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS) as [Topic, string[]][]) {
    if (topic !== 'general' && keywords.some(kw => lower.includes(kw))) {
      matched.push(topic);
    }
  }
  return matched.length > 0 ? matched.slice(0, 3) : ['general'];
}

function hashId(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  }
  return Math.abs(h).toString(36);
}

function stripHTML(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

// Returns the YouTube hqdefault thumbnail URL if a YouTube link is found in text
export function extractYouTubeThumbnail(text: string): string | undefined {
  const match = text.match(
    /(?:youtube\.com\/watch\?[^"'\s]*v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/
  );
  return match ? `https://img.youtube.com/vi/${match[1]}/hqdefault.jpg` : undefined;
}

function extractImage(item: Element, description: string, articleUrl: string): string | undefined {
  // YouTube thumbnail (free, no request needed)
  const ytThumb = extractYouTubeThumbnail(articleUrl + ' ' + description);
  if (ytThumb) return ytThumb;

  const media = item.querySelector('content[medium="image"], content[type^="image"]');
  if (media?.getAttribute('url')) return media.getAttribute('url')!;

  const enclosure = item.querySelector('enclosure');
  if (enclosure?.getAttribute('type')?.startsWith('image')) return enclosure.getAttribute('url') ?? undefined;

  // Also accept video enclosures — use their URL as a preview placeholder
  if (enclosure?.getAttribute('type')?.startsWith('video')) {
    const vidUrl = enclosure.getAttribute('url') ?? '';
    const yt = extractYouTubeThumbnail(vidUrl);
    if (yt) return yt;
  }

  // media:thumbnail — used by YouTube Atom feeds and other video platforms
  // Use getElementsByTagName('*') + localName to match regardless of namespace prefix
  const allDescendants = Array.from(item.getElementsByTagName('*'));
  for (const el of allDescendants) {
    if (el.localName === 'thumbnail' && el.getAttribute('url')) return el.getAttribute('url')!;
  }
  for (const el of allDescendants) {
    if (el.localName === 'content' && el.getAttribute('url')) {
      const type = el.getAttribute('medium') ?? el.getAttribute('type') ?? '';
      if (type.includes('image') || el.getAttribute('url')?.match(/\.(jpg|jpeg|png|webp)/i)) {
        return el.getAttribute('url')!;
      }
    }
  }

  // og:image embedded directly in the feed description HTML
  const ogMatch = description.match(/property=["']og:image["'][^>]*content=["']([^"'>"]+)["']|content=["']([^"'>"]+)["'][^>]*property=["']og:image["']/i);
  if (ogMatch) return ogMatch[1] ?? ogMatch[2];

  const imgMatch = description.match(/<img[^>]+src=["']([^"']+)["']/i);
  return imgMatch?.[1];
}

function parseFeed(xml: string, source: NewsSource): Article[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');
  const items = Array.from(doc.querySelectorAll('item, entry'));

  return items.flatMap(item => {
    const title = decodeEntities(stripHTML(item.querySelector('title')?.textContent ?? ''));
    const rawLink = item.querySelector('link')?.textContent?.trim()
      ?? item.querySelector('link')?.getAttribute('href')
      ?? '';
    const url = rawLink.trim();
    if (!title || !url || !url.startsWith('http')) return [];

    const rawDesc = item.querySelector('description, summary, content')?.textContent ?? '';
    const description = stripHTML(decodeEntities(rawDesc)).slice(0, 280);
    const pubDateStr = item.querySelector('pubDate, published, updated, dc\\:date')?.textContent?.trim() ?? '';
    const publishedAt = pubDateStr ? new Date(pubDateStr) : new Date();
    const imageUrl = extractImage(item, rawDesc, url);
    const topics = detectTopics(title + ' ' + description);

    return [{
      id: hashId(url),
      title,
      url,
      description,
      imageUrl,
      publishedAt: isNaN(publishedAt.getTime()) ? new Date() : publishedAt,
      source: source.name,
      sourceId: source.id,
      topics,
    }];
  });
}

// Race both proxies: resolves with whichever returns valid content first.
// Falls back to the slower one if the first returns empty/errors.
async function fetchXML(feedUrl: string, signal: AbortSignal): Promise<string> {
  const tryPrimary = async (): Promise<string> => {
    const res = await fetch(PROXY_PRIMARY(feedUrl), { signal });
    if (!res.ok) throw new Error(`primary ${res.status}`);
    const data = await res.json() as { contents?: string };
    if (!data.contents || data.contents.length < 200) throw new Error('primary empty');
    return data.contents;
  };

  const tryFallback = async (): Promise<string> => {
    const res = await fetch(PROXY_FALLBACK(feedUrl), { signal });
    if (!res.ok) throw new Error(`fallback ${res.status}`);
    const text = await res.text();
    if (text.length < 100) throw new Error('fallback empty');
    return text;
  };

  // Race: return first successful result; if both fail, throw the last error.
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let failures = 0;
    let lastErr: unknown;
    const done = (result: string) => { if (!settled) { settled = true; resolve(result); } };
    const fail = (err: unknown) => { lastErr = err; if (++failures === 2 && !settled) reject(lastErr); };
    tryPrimary().then(done).catch(fail);
    tryFallback().then(done).catch(fail);
  });
}

export async function fetchSource(source: NewsSource): Promise<Article[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000); // 6 s — fail fast
  try {
    const xml = await fetchXML(source.feedUrl, controller.signal);
    return parseFeed(xml, source);
  } finally {
    clearTimeout(timeout);
  }
}

// Fetches sources in two tiers:
//   Tier 1 (priority=1): fetched first; onBatch fires as soon as any resolves
//   Tier 2 (priority=2): fetched concurrently after tier-1 starts
// This way the UI renders visible content within ~2 s without waiting for
// all 40+ sources to settle.
export async function fetchAllSources(
  sources: NewsSource[],
  onBatch?: (articles: Article[]) => void,
): Promise<Article[]> {
  const tier1 = sources.filter(s => (s.priority ?? 2) === 1);
  const tier2 = sources.filter(s => (s.priority ?? 2) !== 1);

  const accumulated: Article[] = [];

  const fetchOne = (source: NewsSource) =>
    fetchSource(source)
      .then(articles => {
        accumulated.push(...articles);
        onBatch?.(accumulated);
      })
      .catch(() => {}); // silent per-source failure

  // Kick off both tiers immediately in parallel — tier-1 sources are faster
  // so they will call onBatch first, giving instant visible content.
  await Promise.allSettled([
    ...tier1.map(fetchOne),
    ...tier2.map(fetchOne),
  ]);

  return accumulated;
}
