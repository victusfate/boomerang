import type { Article, NewsSource, Topic } from '../types';

const CORS_PROXY = 'https://api.allorigins.win/get?url=';

export const DEFAULT_SOURCES: NewsSource[] = [
  { id: 'hn',       name: 'Hacker News',      feedUrl: 'https://news.ycombinator.com/rss',                         category: 'technology', enabled: true  },
  { id: 'bbc',      name: 'BBC News',          feedUrl: 'https://feeds.bbci.co.uk/news/rss.xml',                    category: 'world',      enabled: true  },
  { id: 'guardian', name: 'The Guardian',      feedUrl: 'https://www.theguardian.com/world/rss',                    category: 'world',      enabled: true  },
  { id: 'ars',      name: 'Ars Technica',      feedUrl: 'https://feeds.arstechnica.com/arstechnica/index',          category: 'technology', enabled: true  },
  { id: 'npm',      name: 'NPR News',          feedUrl: 'https://feeds.npr.org/1001/rss.xml',                       category: 'world',      enabled: true  },
  { id: 'mit',      name: 'MIT Tech Review',   feedUrl: 'https://www.technologyreview.com/feed/',                   category: 'technology', enabled: true  },
  { id: 'wired',    name: 'Wired',             feedUrl: 'https://www.wired.com/feed/rss',                           category: 'technology', enabled: false },
  { id: 'nature',   name: 'Nature',            feedUrl: 'https://www.nature.com/nature/current_issue/rss',          category: 'science',    enabled: false },
  { id: 'nasa',     name: 'NASA',              feedUrl: 'https://www.nasa.gov/rss/dyn/breaking_news.rss',            category: 'science',    enabled: false },
  { id: 'devto',    name: 'Dev.to',            feedUrl: 'https://dev.to/feed',                                      category: 'technology', enabled: false },
  { id: 'verge',    name: 'The Verge',         feedUrl: 'https://www.theverge.com/rss/index.xml',                   category: 'technology', enabled: false },
  { id: 'smash',    name: 'Smashing Magazine', feedUrl: 'https://www.smashingmagazine.com/feed/',                   category: 'technology', enabled: false },
  { id: 'eco',      name: 'The Economist',     feedUrl: 'https://www.economist.com/latest/rss.xml',                 category: 'world',      enabled: false },
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

function extractImage(item: Element, description: string): string | undefined {
  const media = item.querySelector('content[medium="image"], content[type^="image"]');
  if (media?.getAttribute('url')) return media.getAttribute('url')!;

  const enclosure = item.querySelector('enclosure');
  if (enclosure?.getAttribute('type')?.startsWith('image')) return enclosure.getAttribute('url') ?? undefined;

  // Try media:content (namespace-stripped by DOMParser in some envs)
  const allEls = Array.from(item.children);
  for (const el of allEls) {
    if (el.tagName.toLowerCase().includes('content') && el.getAttribute('url')) {
      const type = el.getAttribute('medium') ?? el.getAttribute('type') ?? '';
      if (type.includes('image') || el.getAttribute('url')?.match(/\.(jpg|jpeg|png|webp)/i)) {
        return el.getAttribute('url')!;
      }
    }
  }

  // Extract first <img> from description HTML
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
    if (!title || !url || url.startsWith('http') === false) return [];

    const rawDesc = item.querySelector('description, summary, content')?.textContent ?? '';
    const description = stripHTML(decodeEntities(rawDesc)).slice(0, 280);
    const pubDateStr = item.querySelector('pubDate, published, updated, dc\\:date')?.textContent?.trim() ?? '';
    const publishedAt = pubDateStr ? new Date(pubDateStr) : new Date();
    const imageUrl = extractImage(item, rawDesc);
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

export async function fetchSource(source: NewsSource): Promise<Article[]> {
  const url = `${CORS_PROXY}${encodeURIComponent(source.feedUrl)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json() as { contents: string };
  return parseFeed(data.contents, source);
}

export async function fetchAllSources(sources: NewsSource[]): Promise<Article[]> {
  const results = await Promise.allSettled(sources.map(fetchSource));
  return results
    .filter((r): r is PromiseFulfilledResult<Article[]> => r.status === 'fulfilled')
    .flatMap(r => r.value);
}
