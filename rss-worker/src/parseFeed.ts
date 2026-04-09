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

/** Canonical http(s) URL — fixes literal &amp; in XML hrefs (breaks YouTube watch links in browsers). */
function normalizeHttpUrl(raw: string): string {
  let s = raw.trim();
  if (s.includes('&amp;')) s = s.replace(/&amp;/g, '&');
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw.trim();
    return u.href;
  } catch {
    return raw.trim();
  }
}

function extractYouTubeThumbnail(text: string): string | undefined {
  const match = text.match(
    /(?:youtube\.com\/watch\?[^"'\s]*v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/
  );
  return match ? `https://img.youtube.com/vi/${match[1]}/hqdefault.jpg` : undefined;
}

/** Resolve RSS/HTML image hrefs against the article link so paths are not resolved against the SPA origin in the browser. */
function resolveArticleImageUrl(raw: string, articlePageUrl: string): string | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  if (t.startsWith('?') || t.startsWith('&')) return undefined;
  try {
    const u = new URL(t, articlePageUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

function extractImageFromDescription(rawDesc: string, articleUrl: string): string | undefined {
  const ytThumb = extractYouTubeThumbnail(articleUrl + ' ' + rawDesc);
  if (ytThumb) return ytThumb;
  const ogMatch = rawDesc.match(/property=["']og:image["'][^>]*content=["']([^"'>"]+)["']|content=["']([^"'>"]+)["'][^>]*property=["']og:image["']/i);
  const og = ogMatch?.[1] ?? ogMatch?.[2];
  if (og) return resolveArticleImageUrl(og, articleUrl);
  const imgMatch = rawDesc.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch?.[1]) return resolveArticleImageUrl(imgMatch[1], articleUrl);
  return undefined;
}

/** media:thumbnail @url (Atom/YouTube, Apple Podcasts, many RSS feeds). */
function urlsFromMediaThumbnailNodes(raw: unknown): string[] {
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const n of list) {
    if (n && typeof n === 'object' && '@_url' in n) {
      const u = String((n as { '@_url': string })['@_url']).trim();
      if (u) out.push(u);
    }
  }
  return out;
}

function extractMediaThumbnailFromRecord(rec: Record<string, unknown>): string | undefined {
  const group = rec['media:group'];
  if (group != null) {
    const groups = Array.isArray(group) ? group : [group];
    for (const raw of groups) {
      if (raw && typeof raw === 'object') {
        const g = raw as Record<string, unknown>;
        const fromGroup = urlsFromMediaThumbnailNodes(g['media:thumbnail'])[0];
        if (fromGroup) return fromGroup;
      }
    }
  }
  const top = urlsFromMediaThumbnailNodes(rec['media:thumbnail'])[0];
  if (top) return top;
  return undefined;
}

/** RSS enclosure when type is image/*. */
function extractEnclosureImageUrl(item: Record<string, unknown>): string | undefined {
  const enc = item.enclosure;
  if (enc == null) return undefined;
  const list = Array.isArray(enc) ? enc : [enc];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const o = e as { '@_url'?: string; '@_type'?: string };
    const t = (o['@_type'] ?? '').toLowerCase();
    if (t.startsWith('image/') && o['@_url']) return String(o['@_url']).trim();
  }
  return undefined;
}

/** media:content with medium=image or image/* type (some feeds). */
function extractMediaContentImageUrl(rec: Record<string, unknown>): string | undefined {
  const raw = rec['media:content'];
  if (raw == null) return undefined;
  const list = Array.isArray(raw) ? raw : [raw];
  for (const n of list) {
    if (!n || typeof n !== 'object') continue;
    const o = n as { '@_url'?: string; '@_medium'?: string; '@_type'?: string };
    const medium = (o['@_medium'] ?? '').toLowerCase();
    const type = (o['@_type'] ?? '').toLowerCase();
    if (o['@_url'] && (medium === 'image' || type.startsWith('image/'))) {
      return String(o['@_url']).trim();
    }
  }
  return undefined;
}

function pickStructuredImage(
  record: Record<string, unknown>,
  articleUrl: string,
): string | undefined {
  const raw =
    extractEnclosureImageUrl(record)
    ?? extractMediaContentImageUrl(record)
    ?? extractMediaThumbnailFromRecord(record);
  if (!raw) return undefined;
  return resolveArticleImageUrl(raw, articleUrl);
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
  // YouTube & most Atom feeds: rel="alternate" is the article page (prefer over rel="self" etc.).
  for (const l of arr) {
    if (typeof l === 'object' && l !== null && '@_href' in l) {
      const rel = (l as { '@_rel'?: string })['@_rel'];
      if (rel === 'alternate') return String((l as { '@_href': string })['@_href']);
    }
  }
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
      const url = normalizeHttpUrl(rawLink);
      if (!title || !url || !url.startsWith('http')) continue;

      const enc = (item as Record<string, unknown>)['content:encoded'];
      const rawDesc = textVal(
        item.description ?? enc ?? item.summary ?? '',
      );
      const description = stripHTML(decodeEntities(rawDesc)).slice(0, 280);
      const pubDateStr = textVal(item.pubDate ?? item.published ?? item['dc:date']);
      const publishedAt = pubDateStr ? new Date(pubDateStr) : new Date();
      const imageUrl =
        pickStructuredImage(item as Record<string, unknown>, url)
        ?? extractImageFromDescription(rawDesc, url);
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
      const url = normalizeHttpUrl(parseAtomLink(entry));
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
      const imageUrl =
        pickStructuredImage(entry, url)
        ?? extractImageFromDescription(rawDesc, url);
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
