import { XMLParser } from 'fast-xml-parser';
import type { NewsSource, Topic } from './sources';

/** Wire format — publishedAt ISO string for JSON */
export interface ArticleWire {
  id: string;
  title: string;
  url: string;
  description: string;
  imageUrl?: string;
  publishedAt: string;
  source: string;
  sourceId: string;
  topics: Topic[];
}

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

function extractYouTubeThumbnail(text: string): string | undefined {
  const match = text.match(
    /(?:youtube\.com\/watch\?[^"'\s]*v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/
  );
  return match ? `https://img.youtube.com/vi/${match[1]}/hqdefault.jpg` : undefined;
}

function extractImageFromDescription(rawDesc: string, articleUrl: string): string | undefined {
  const ytThumb = extractYouTubeThumbnail(articleUrl + ' ' + rawDesc);
  if (ytThumb) return ytThumb;
  const ogMatch = rawDesc.match(/property=["']og:image["'][^>]*content=["']([^"'>"]+)["']|content=["']([^"'>"]+)["'][^>]*property=["']og:image["']/i);
  if (ogMatch) return ogMatch[1] ?? ogMatch[2];
  const imgMatch = rawDesc.match(/<img[^>]+src=["']([^"']+)["']/i);
  return imgMatch?.[1];
}

function textVal(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null && '#text' in v) return String((v as { '#text': string })['#text']);
  return String(v);
}

function parseAtomLink(entry: Record<string, unknown>): string {
  const link = entry.link;
  if (!link) return '';
  const arr = Array.isArray(link) ? link : [link];
  for (const l of arr) {
    if (typeof l === 'object' && l !== null && '@_href' in l) {
      const rel = (l as { '@_rel'?: string })['@_rel'];
      if (!rel || rel === 'alternate') return String((l as { '@_href': string })['@_href']);
    }
  }
  const first = arr[0];
  if (typeof first === 'object' && first !== null && '@_href' in first) {
    return String((first as { '@_href': string })['@_href']);
  }
  return '';
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
});

function asArray<T>(x: T | T[] | undefined): T[] {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

export function parseFeed(xml: string, source: NewsSource): ArticleWire[] {
  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch {
    return [];
  }
  if (!doc || typeof doc !== 'object') return [];

  const out: ArticleWire[] = [];

  const rss = (doc as { rss?: { channel?: unknown } }).rss;
  if (rss?.channel) {
    const channel = rss.channel as Record<string, unknown>;
    const items = asArray(channel.item as Record<string, unknown> | undefined);
    for (const item of items) {
      const title = decodeEntities(stripHTML(textVal(item.title)));
      const linkRaw = item.link as unknown;
      let rawLink = '';
      if (typeof linkRaw === 'string') rawLink = linkRaw;
      else if (linkRaw && typeof linkRaw === 'object' && '@_href' in linkRaw) {
        rawLink = String((linkRaw as { '@_href': string })['@_href']);
      } else {
        rawLink = textVal(item.link);
      }
      const url = rawLink.trim();
      if (!title || !url || !url.startsWith('http')) continue;

      const enc = (item as Record<string, unknown>)['content:encoded'];
      const rawDesc = textVal(
        item.description ?? enc ?? item.summary ?? '',
      );
      const description = stripHTML(decodeEntities(rawDesc)).slice(0, 280);
      const pubDateStr = textVal(item.pubDate ?? item.published ?? item['dc:date']);
      const publishedAt = pubDateStr ? new Date(pubDateStr) : new Date();
      const imageUrl = extractImageFromDescription(rawDesc, url);
      const topics = detectTopics(title + ' ' + description);

      out.push({
        id: hashId(url),
        title,
        url,
        description,
        imageUrl,
        publishedAt: (isNaN(publishedAt.getTime()) ? new Date() : publishedAt).toISOString(),
        source: source.name,
        sourceId: source.id,
        topics,
      });
    }
    return out;
  }

  const feed = (doc as { feed?: { entry?: unknown } }).feed;
  if (feed?.entry) {
    const entries = asArray(feed.entry as Record<string, unknown> | undefined);
    for (const entry of entries) {
      const title = decodeEntities(stripHTML(textVal(entry.title)));
      const url = parseAtomLink(entry);
      if (!title || !url || !url.startsWith('http')) continue;

      const contentEl = entry.content;
      let rawDesc = '';
      if (typeof contentEl === 'object' && contentEl !== null) {
        const c = contentEl as Record<string, unknown>;
        rawDesc = textVal(c['#text'] ?? c);
      } else {
        rawDesc = textVal(entry.summary ?? entry.content);
      }
      const description = stripHTML(decodeEntities(rawDesc)).slice(0, 280);
      const pubDateStr = textVal(entry.published ?? entry.updated);
      const publishedAt = pubDateStr ? new Date(pubDateStr) : new Date();
      const imageUrl = extractImageFromDescription(rawDesc, url);
      const topics = detectTopics(title + ' ' + description);

      out.push({
        id: hashId(url),
        title,
        url,
        description,
        imageUrl,
        publishedAt: (isNaN(publishedAt.getTime()) ? new Date() : publishedAt).toISOString(),
        source: source.name,
        sourceId: source.id,
        topics,
      });
    }
  }

  return out;
}
