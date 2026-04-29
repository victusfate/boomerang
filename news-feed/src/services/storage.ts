// Pure utility functions for prefs manipulation.
// Persistence is handled by Fireproof in useFeed.ts.

import type { Article, CustomSource, NewsSource, Topic, UserLabel, UserPrefs } from '../types';

export const DEFAULT_PREFS: UserPrefs = {
  topicWeights:   {},
  sourceWeights:  {},
  keywordWeights: {},
  readIds:        [],
  savedIds:       [],
  seenIds:        [],
  upvotedIds:     [],
  downvotedIds:   [],
  lastDecayAt:    0,
  enabledSources:    [],  // legacy — kept for migration only
  disabledSourceIds: [],  // blacklist: empty = all enabled
  enabledTopics:  [],   // empty = all enabled
  customSources:  [],
  userLabels:     [],
  hideAiBar:      false,
};

// ── Keyword extraction ────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the','and','for','with','that','this','from','have','will','been',
  'are','was','were','its','has','but','not','more','into','than','over',
  'also','about','after','their','they','said','when','what','which',
  'there','would','could','should','being','some','just',
]);

const MAX_KEYWORDS = 500; // cap stored entries — evict lowest-magnitude on overflow
const MAX_SEEN_IDS = 2_000; // keep only most-recent seen IDs
const MAX_READ_IDS = 1_000; // keep only most-recent read IDs

export function extractKeywords(text: string): string[] {
  return [...new Set(
    text.toLowerCase()
      .split(/\W+/)
      .filter(w => w.length > 4 && !STOPWORDS.has(w))
  )].slice(0, 12);
}

function trimKeywords(weights: Record<string, number>): Record<string, number> {
  const entries = Object.entries(weights);
  if (entries.length <= MAX_KEYWORDS) return weights;
  entries.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  return Object.fromEntries(entries.slice(0, MAX_KEYWORDS));
}

// ── Existing actions ──────────────────────────────────────────────────────────

export function markRead(id: string, prefs: UserPrefs): UserPrefs {
  if (prefs.readIds.includes(id)) return prefs;
  const readIds = [...prefs.readIds, id];
  return { ...prefs, readIds: readIds.length > MAX_READ_IDS ? readIds.slice(-MAX_READ_IDS) : readIds };
}

export function markSeen(ids: string[], prefs: UserPrefs): UserPrefs {
  const existing = new Set(prefs.seenIds);
  const fresh = ids.filter(id => !existing.has(id));
  if (fresh.length === 0) return prefs;
  const seenIds = [...prefs.seenIds, ...fresh];
  return { ...prefs, seenIds: seenIds.length > MAX_SEEN_IDS ? seenIds.slice(-MAX_SEEN_IDS) : seenIds };
}

export function toggleSaved(id: string, prefs: UserPrefs): UserPrefs {
  const saved = prefs.savedIds.includes(id)
    ? prefs.savedIds.filter(x => x !== id)
    : [...prefs.savedIds, id];
  return { ...prefs, savedIds: saved };
}

export function boostTopic(topic: Topic, prefs: UserPrefs): UserPrefs {
  const current = prefs.topicWeights[topic] ?? 1.0;
  return {
    ...prefs,
    topicWeights: { ...prefs.topicWeights, [topic]: Math.min(current + 0.2, 3.0) },
  };
}

export function toggleSource(sourceId: string, prefs: UserPrefs): UserPrefs {
  const disabled = prefs.disabledSourceIds ?? [];
  const next = disabled.includes(sourceId)
    ? disabled.filter(x => x !== sourceId)
    : [...disabled, sourceId];
  return { ...prefs, disabledSourceIds: next };
}

export function toggleTopic(topic: Topic, prefs: UserPrefs): UserPrefs {
  const enabled = prefs.enabledTopics.includes(topic)
    ? prefs.enabledTopics.filter(x => x !== topic)
    : [...prefs.enabledTopics, topic];
  return { ...prefs, enabledTopics: enabled };
}

export function isSourceEnabled(sourceId: string, prefs: UserPrefs): boolean {
  return !(prefs.disabledSourceIds ?? []).includes(sourceId);
}

export function isTopicEnabled(topic: Topic, prefs: UserPrefs): boolean {
  return prefs.enabledTopics.length === 0 || prefs.enabledTopics.includes(topic);
}

// ── Vote actions ──────────────────────────────────────────────────────────────

export function upvote(article: Article, prefs: UserPrefs): UserPrefs {
  // Toggle: clicking again removes the upvote (no weight reversal — weights are soft signals)
  if (prefs.upvotedIds.includes(article.id)) {
    return {
      ...prefs,
      upvotedIds: prefs.upvotedIds.filter(id => id !== article.id),
    };
  }

  const topicWeights = { ...prefs.topicWeights };
  for (const t of article.topics) {
    topicWeights[t] = Math.min((topicWeights[t] ?? 1.0) + 0.3, 3.0);
  }

  const srcId = article.sourceId;
  const sourceWeights = {
    ...prefs.sourceWeights,
    [srcId]: Math.min((prefs.sourceWeights[srcId] ?? 1.0) + 0.2, 3.0),
  };

  const keywordWeights = { ...prefs.keywordWeights };
  for (const kw of extractKeywords(article.title + ' ' + article.description)) {
    keywordWeights[kw] = Math.min((keywordWeights[kw] ?? 0) + 0.4, 5.0);
  }

  return {
    ...prefs,
    topicWeights,
    sourceWeights,
    keywordWeights: trimKeywords(keywordWeights),
    upvotedIds:   [...prefs.upvotedIds, article.id],
    downvotedIds: prefs.downvotedIds.filter(id => id !== article.id),
  };
}

export function downvote(article: Article, prefs: UserPrefs): UserPrefs {
  // Toggle: clicking again removes the downvote
  if (prefs.downvotedIds.includes(article.id)) {
    return {
      ...prefs,
      downvotedIds: prefs.downvotedIds.filter(id => id !== article.id),
    };
  }

  const topicWeights = { ...prefs.topicWeights };
  for (const t of article.topics) {
    topicWeights[t] = Math.max((topicWeights[t] ?? 1.0) - 0.2, 0.1);
  }

  const srcId = article.sourceId;
  const sourceWeights = {
    ...prefs.sourceWeights,
    [srcId]: Math.max((prefs.sourceWeights[srcId] ?? 1.0) - 0.15, 0.1),
  };

  const keywordWeights = { ...prefs.keywordWeights };
  for (const kw of extractKeywords(article.title + ' ' + article.description)) {
    keywordWeights[kw] = Math.max((keywordWeights[kw] ?? 0) - 0.3, -5.0);
  }

  return {
    ...prefs,
    topicWeights,
    sourceWeights,
    keywordWeights: trimKeywords(keywordWeights),
    downvotedIds: [...prefs.downvotedIds, article.id],
    upvotedIds:   prefs.upvotedIds.filter(id => id !== article.id),
  };
}

// ── Weight decay ──────────────────────────────────────────────────────────────
// Call on session start. If 7+ days have passed, nudge weights back toward
// neutral so old preferences don't lock in forever.

const DECAY_INTERVAL = 7 * 24 * 60 * 60 * 1000;

export function applyDecay(prefs: UserPrefs): UserPrefs {
  if (Date.now() - prefs.lastDecayAt < DECAY_INTERVAL) return prefs;

  const topicWeights: Partial<Record<Topic, number>> = {};
  for (const [t, w] of Object.entries(prefs.topicWeights) as [Topic, number][]) {
    topicWeights[t] = w + (1.0 - w) * 0.1; // drift 10% back toward 1.0
  }

  const keywordWeights: Record<string, number> = {};
  for (const [kw, w] of Object.entries(prefs.keywordWeights)) {
    keywordWeights[kw] = w * 0.85; // decay magnitude by 15%
  }

  return { ...prefs, topicWeights, keywordWeights, lastDecayAt: Date.now() };
}

// ── Reset ─────────────────────────────────────────────────────────────────────

export function resetLearnedWeights(prefs: UserPrefs): UserPrefs {
  return {
    ...prefs,
    topicWeights:   {},
    sourceWeights:  {},
    keywordWeights: {},
    upvotedIds:     [],
    downvotedIds:   [],
    lastDecayAt:    Date.now(),
  };
}

export function clearViewedCache(prefs: UserPrefs): UserPrefs {
  return { ...prefs, seenIds: [], readIds: [] };
}

// ── Custom sources ────────────────────────────────────────────────────────────

export function addCustomSource(source: CustomSource, prefs: UserPrefs): UserPrefs {
  if (prefs.customSources.some(s => s.id === source.id)) return prefs;
  return { ...prefs, customSources: [...prefs.customSources, source] };
}

export function removeCustomSource(id: string, prefs: UserPrefs): UserPrefs {
  return { ...prefs, customSources: prefs.customSources.filter(s => s.id !== id) };
}

// ── Bookmark export / import ──────────────────────────────────────────────────
// Encodes key preferences as a base64 URL fragment for cross-device restore.
// Uses TextEncoder so non-ASCII source names survive the round-trip.
// v2 adds optional savedSnapshots so starred items survive import in an empty profile
// (e.g. private window) — RSS alone may not include older saved article IDs.

export type BookmarkArticleSnapshot = Omit<Article, 'publishedAt'> & { publishedAt: string };

export interface ImportedBookmark {
  prefs: Partial<UserPrefs>;
  /** Article bodies for saved IDs when re-exported from v2 bookmarks */
  savedSnapshots?: BookmarkArticleSnapshot[];
}

interface BookmarkPayloadV1 {
  v: 1;
  upvotedIds:    string[];
  downvotedIds:  string[];
  savedIds:      string[];
  readIds:       string[];
  customSources: CustomSource[];
  enabledSources: string[];
  enabledTopics:  string[];
  topicWeights:   Partial<Record<Topic, number>>;
  sourceWeights:  Record<string, number>;
  keywordWeights: Record<string, number>;
}

interface BookmarkPayloadV2 extends Omit<BookmarkPayloadV1, 'v'> {
  v: 2;
  savedSnapshots?: BookmarkArticleSnapshot[];
}

function prefsToBookmarkFields(prefs: UserPrefs): Omit<BookmarkPayloadV1, 'v'> {
  return {
    upvotedIds:    prefs.upvotedIds,
    downvotedIds:  prefs.downvotedIds,
    savedIds:      prefs.savedIds,
    readIds:       prefs.readIds,
    customSources: prefs.customSources,
    enabledSources: prefs.enabledSources,
    enabledTopics:  prefs.enabledTopics as string[],
    topicWeights:   prefs.topicWeights,
    sourceWeights:  prefs.sourceWeights,
    keywordWeights: prefs.keywordWeights,
  };
}

function articleToSnapshot(a: Article): BookmarkArticleSnapshot {
  return { ...a, publishedAt: a.publishedAt.toISOString() };
}

/** @param savedArticles — current article rows for saved IDs (so imports work without RSS overlap) */
export function exportPrefsBookmark(prefs: UserPrefs, savedArticles?: Article[]): string {
  const fields = prefsToBookmarkFields(prefs);
  const payload: BookmarkPayloadV2 = {
    v: 2,
    ...fields,
    savedSnapshots:
      savedArticles && savedArticles.length > 0 ? savedArticles.map(articleToSnapshot) : undefined,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

function parseBookmarkPrefs(p: Partial<Omit<BookmarkPayloadV1, 'v'>>): Partial<UserPrefs> {
  const out: Partial<UserPrefs> = {};
  if (Array.isArray(p.upvotedIds))    out.upvotedIds    = p.upvotedIds;
  if (Array.isArray(p.downvotedIds))  out.downvotedIds  = p.downvotedIds;
  if (Array.isArray(p.savedIds))      out.savedIds      = p.savedIds;
  if (Array.isArray(p.readIds))       out.readIds       = p.readIds;
  if (Array.isArray(p.customSources)) out.customSources = p.customSources;
  if (Array.isArray(p.enabledSources)) out.enabledSources = p.enabledSources;
  if (Array.isArray(p.enabledTopics))  out.enabledTopics  = p.enabledTopics as Topic[];
  if (p.topicWeights && typeof p.topicWeights === 'object')   out.topicWeights   = p.topicWeights;
  if (p.sourceWeights && typeof p.sourceWeights === 'object') out.sourceWeights  = p.sourceWeights;
  if (p.keywordWeights && typeof p.keywordWeights === 'object') out.keywordWeights = p.keywordWeights;
  return out;
}

export function importPrefsBookmark(encoded: string): ImportedBookmark | null {
  try {
    const binary = atob(encoded.trim());
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);
    const p = JSON.parse(json) as Partial<BookmarkPayloadV1 | BookmarkPayloadV2>;
    if (p.v !== 1 && p.v !== 2) return null;
    const prefs = parseBookmarkPrefs(p);
    let savedSnapshots: BookmarkArticleSnapshot[] | undefined;
    if (p.v === 2 && Array.isArray(p.savedSnapshots) && p.savedSnapshots.length > 0) {
      savedSnapshots = p.savedSnapshots.filter(
        s => s && typeof s.id === 'string' && typeof s.title === 'string' && typeof s.url === 'string',
      );
    }
    return { prefs, savedSnapshots };
  } catch {
    return null;
  }
}

/** Merge fetched articles with bookmark snapshots so saved items missing from RSS still appear. */
export function mergePoolWithSavedSnapshots(
  fetched: Article[],
  savedIds: string[],
  snapshots: Map<string, Article>,
): Article[] {
  const byId = new Map(fetched.map(a => [a.id, a]));
  for (const id of savedIds) {
    if (!byId.has(id) && snapshots.has(id)) {
      byId.set(id, snapshots.get(id)!);
    }
  }
  return Array.from(byId.values());
}

// ── OPML export / import ──────────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Generate an OPML 2.0 file with all built-in and custom sources.
 * Disabled sources are marked with `boomerangDisabled="true"` so an import
 * round-trip preserves the enabled/disabled state.
 * Custom sources carry `boomerangCustom="true"` so they are re-added on import.
 */
export function exportOPML(
  defaultSources: NewsSource[],
  customSources: CustomSource[],
  disabledSourceIds: string[],
): string {
  const categories: Record<string, NewsSource[]> = {};
  for (const s of defaultSources) {
    (categories[s.category] ??= []).push(s);
  }

  const toOutline = (name: string, url: string, id: string, extra = '') => {
    const dis = disabledSourceIds.includes(id) ? ' boomerangDisabled="true"' : '';
    return `      <outline type="rss" text="${escapeXml(name)}" title="${escapeXml(name)}" xmlUrl="${escapeXml(url)}"${dis}${extra}/>`;
  };

  const groups: string[] = [];
  for (const [cat, sources] of Object.entries(categories)) {
    const label = cat.charAt(0).toUpperCase() + cat.slice(1);
    const lines = sources.map(s => toOutline(s.name, s.feedUrl, s.id));
    groups.push(`    <outline text="${label}" title="${label}">\n${lines.join('\n')}\n    </outline>`);
  }
  if (customSources.length > 0) {
    const lines = customSources.map(s => toOutline(s.name, s.feedUrl, s.id, ' boomerangCustom="true"'));
    groups.push(`    <outline text="Custom" title="Custom">\n${lines.join('\n')}\n    </outline>`);
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    '    <title>Boomerang News Feeds</title>',
    `    <dateCreated>${new Date().toUTCString()}</dateCreated>`,
    '  </head>',
    '  <body>',
    ...groups,
    '  </body>',
    '</opml>',
  ].join('\n');
}

export interface ImportedOPML {
  /** Sources to disable — sources absent from the OPML or marked boomerangDisabled are disabled */
  disabledSourceIds: string[];
  /** Custom sources extracted from the OPML (unknown URLs + boomerangCustom entries) */
  customSources: CustomSource[];
}

/**
 * Parse an OPML XML string and return the new source configuration.
 * Sources present in the file without boomerangDisabled are enabled;
 * built-in sources absent from the file are disabled.
 * Unknown URLs become new custom sources.
 */
export function importOPML(xml: string, defaultSources: NewsSource[]): ImportedOPML | null {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) return null;

    const outlines = Array.from(doc.querySelectorAll('outline[xmlUrl]'));
    if (outlines.length === 0) return null;

    const opmlEntries = new Map<string, { disabled: boolean; custom: boolean; name: string }>();
    for (const el of outlines) {
      const xmlUrl = el.getAttribute('xmlUrl')?.trim();
      if (!xmlUrl) continue;
      opmlEntries.set(xmlUrl, {
        disabled: el.getAttribute('boomerangDisabled') === 'true',
        custom:   el.getAttribute('boomerangCustom')   === 'true',
        name:     el.getAttribute('text') || el.getAttribute('title') || xmlUrl,
      });
    }

    const defaultUrlSet = new Set(defaultSources.map(s => s.feedUrl));

    // Built-in sources not in OPML, or explicitly disabled → go into disabledSourceIds
    const newDisabledIds: string[] = [];
    for (const s of defaultSources) {
      const entry = opmlEntries.get(s.feedUrl);
      if (!entry || entry.disabled) newDisabledIds.push(s.id);
    }

    // URLs not matching any built-in source → custom sources
    const newCustomSources: CustomSource[] = [];
    let idx = 0;
    for (const [url, { name }] of opmlEntries) {
      if (!defaultUrlSet.has(url)) {
        newCustomSources.push({
          id: `custom-${Date.now().toString(36)}-${(idx++).toString(36)}`,
          name,
          feedUrl: url,
        });
      }
    }

    return { disabledSourceIds: newDisabledIds, customSources: newCustomSources };
  } catch {
    return null;
  }
}

// ── Browser bookmarks export / import ─────────────────────────────────────────

function bmId(url: string): string {
  // Stable ID derived from URL so re-imports don't duplicate
  let h = 0;
  for (let i = 0; i < url.length; i++) { h = Math.imul(31, h) + url.charCodeAt(i) | 0; }
  return `bm-${(h >>> 0).toString(36)}`;
}

/** Export saved articles as a Netscape HTML bookmarks file. */
export function exportBookmarkHTML(articles: Article[]): string {
  const items = articles.map(a => {
    const ts = Math.floor(a.publishedAt.getTime() / 1000);
    return `    <DT><A HREF="${escapeXml(a.url)}" ADD_DATE="${ts}">${escapeXml(a.title)}</A>`;
  }).join('\n');
  return [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Boomerang Saved Articles</TITLE>',
    '<H1>Boomerang Saved Articles</H1>',
    '<DL><p>',
    '  <DT><H3>Saved</H3>',
    '  <DL><p>',
    items,
    '  </DL><p>',
    '</DL>',
  ].join('\n');
}

/** Parse a Netscape HTML bookmarks file and return minimal Article objects. */
export function importBookmarkHTML(html: string): Article[] | null {
  try {
    const doc    = new DOMParser().parseFromString(html, 'text/html');
    const links  = Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href]'));
    if (links.length === 0) return null;
    const articles: Article[] = [];
    for (const a of links) {
      const url = a.getAttribute('href')?.trim();
      if (!url || !/^https?:\/\//i.test(url)) continue;
      const title   = a.textContent?.trim() || url;
      const addDate = a.getAttribute('ADD_DATE');
      const ts      = addDate ? parseInt(addDate, 10) * 1000 : Date.now();
      let host = url;
      try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
      articles.push({
        id:          bmId(url),
        title,
        url,
        description: '',
        publishedAt: new Date(isNaN(ts) ? Date.now() : ts),
        source:      host,
        sourceId:    `bm-${host}`,
        topics:      [],
      });
    }
    return articles.length > 0 ? articles : null;
  } catch {
    return null;
  }
}

// ── User label CRUD ───────────────────────────────────────────────────────────

export function addUserLabel(label: UserLabel, prefs: UserPrefs): UserPrefs {
  if (prefs.userLabels.some(l => l.id === label.id)) return prefs;
  return { ...prefs, userLabels: [...prefs.userLabels, label] };
}

export function deleteUserLabel(labelId: string, prefs: UserPrefs): UserPrefs {
  return { ...prefs, userLabels: prefs.userLabels.filter(l => l.id !== labelId) };
}

export function renameUserLabel(labelId: string, name: string, prefs: UserPrefs): UserPrefs {
  return {
    ...prefs,
    userLabels: prefs.userLabels.map(l => l.id === labelId ? { ...l, name } : l),
  };
}
