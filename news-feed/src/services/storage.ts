/**
 * UserPrefs helpers and defaults. Pure utility — persistence is handled by Fireproof in `useFeed`.
 * @module services/storage
 * @category Prefs
 */

import type { Article, CustomSource, NewsSource, Topic, UserLabel, UserPrefs } from '../types';

export const DEFAULT_PREFS: UserPrefs = {
  topicWeights:   {},
  sourceWeights:  {},
  keywordWeights: {},
  readIds:        [],
  savedIds:       [],
  savedAtById:    {},
  unsavedAtById:  {},
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
  theme:          'dark',
};

// ── Keyword extraction ────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the','and','for','with','that','this','from','have','will','been',
  'are','was','were','its','has','but','not','more','into','than','over',
  'also','about','after','their','they','said','when','what','which',
  'there','would','could','should','being','some','just',
]);

const MAX_KEYWORDS = 500; // cap stored entries — evict lowest-magnitude on overflow
export const MAX_SEEN_IDS = 2_000; // keep only most-recent seen IDs
export const MAX_READ_IDS = 1_000; // keep only most-recent read IDs

const TOPIC_WEIGHT_MIN        = 0.1;
const TOPIC_WEIGHT_MAX        = 3.0;
const SOURCE_WEIGHT_MAX       = 3.0;
const SOURCE_WEIGHT_MIN       = 0.1;
const KEYWORD_WEIGHT_MAX      = 5.0;
const KEYWORD_WEIGHT_MIN      = -5.0;
const UPVOTE_TOPIC_DELTA      = 0.3;
const UPVOTE_SOURCE_DELTA     = 0.2;
const UPVOTE_KEYWORD_DELTA    = 0.4;
const DOWNVOTE_TOPIC_DELTA    = 0.2;
const DOWNVOTE_SOURCE_DELTA   = 0.15;
const DOWNVOTE_KEYWORD_DELTA  = 0.3;
const BOOST_TOPIC_DELTA       = 0.2;
const DECAY_DRIFT_RATE        = 0.1;  // drift 10% toward neutral per decay cycle
const KEYWORD_DECAY_FACTOR    = 0.85; // reduce keyword magnitude 15% per cycle
const MAX_KEYWORD_EXTRACT     = 12;
const HASH_PRIME              = 31;
const MS_PER_SECOND           = 1000;

export function extractKeywords(text: string): string[] {
  return [...new Set(
    text.toLowerCase()
      .split(/\W+/)
      .filter(w => w.length > 4 && !STOPWORDS.has(w))
  )].slice(0, MAX_KEYWORD_EXTRACT);
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
  const alreadySaved = prefs.savedIds.includes(id);
  if (alreadySaved) {
    const { [id]: _removed, ...restSavedAt } = prefs.savedAtById ?? {};
    const nextUnsavedAt = { ...(prefs.unsavedAtById ?? {}), [id]: Date.now() };
    return {
      ...prefs,
      savedIds: prefs.savedIds.filter(x => x !== id),
      savedAtById: restSavedAt,
      unsavedAtById: nextUnsavedAt,
    };
  }
  const { [id]: _removedUnsaved, ...restUnsavedAt } = prefs.unsavedAtById ?? {};
  return {
    ...prefs,
    savedIds: [...prefs.savedIds, id],
    savedAtById: { ...(prefs.savedAtById ?? {}), [id]: Date.now() },
    unsavedAtById: restUnsavedAt,
  };
}

export function clearQueue(prefs: UserPrefs): UserPrefs {
  const now = Date.now();
  const nextUnsavedAt = { ...(prefs.unsavedAtById ?? {}) };
  for (const id of prefs.savedIds) nextUnsavedAt[id] = now;
  return { ...prefs, savedIds: [], savedAtById: {}, unsavedAtById: nextUnsavedAt };
}

export function boostTopic(topic: Topic, prefs: UserPrefs): UserPrefs {
  const current = prefs.topicWeights[topic] ?? 1.0;
  return {
    ...prefs,
    topicWeights: { ...prefs.topicWeights, [topic]: Math.min(current + BOOST_TOPIC_DELTA, TOPIC_WEIGHT_MAX) },
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

type VoteWeightUpdate = Pick<UserPrefs, 'topicWeights' | 'sourceWeights' | 'keywordWeights'>;

interface VoteDeltas {
  topicDelta: number;   topicBound: (v: number) => number;
  sourceDelta: number;  sourceBound: (v: number) => number;
  keywordDelta: number; keywordBound: (v: number) => number;
}

const UP_DELTAS: VoteDeltas = {
  topicDelta:   UPVOTE_TOPIC_DELTA,   topicBound:   v => Math.min(v, TOPIC_WEIGHT_MAX),
  sourceDelta:  UPVOTE_SOURCE_DELTA,  sourceBound:  v => Math.min(v, SOURCE_WEIGHT_MAX),
  keywordDelta: UPVOTE_KEYWORD_DELTA, keywordBound: v => Math.min(v, KEYWORD_WEIGHT_MAX),
};

const DOWN_DELTAS: VoteDeltas = {
  topicDelta:   -DOWNVOTE_TOPIC_DELTA,   topicBound:   v => Math.max(v, TOPIC_WEIGHT_MIN),
  sourceDelta:  -DOWNVOTE_SOURCE_DELTA,  sourceBound:  v => Math.max(v, SOURCE_WEIGHT_MIN),
  keywordDelta: -DOWNVOTE_KEYWORD_DELTA, keywordBound: v => Math.max(v, KEYWORD_WEIGHT_MIN),
};

function applyVoteWeights(article: Article, prefs: UserPrefs, d: VoteDeltas): VoteWeightUpdate {
  const topicWeights = { ...prefs.topicWeights };
  for (const t of article.topics) {
    topicWeights[t] = d.topicBound((topicWeights[t] ?? 1.0) + d.topicDelta);
  }
  const sourceWeights = {
    ...prefs.sourceWeights,
    [article.sourceId]: d.sourceBound((prefs.sourceWeights[article.sourceId] ?? 1.0) + d.sourceDelta),
  };
  const keywordWeights = { ...prefs.keywordWeights };
  for (const kw of extractKeywords(article.title + ' ' + article.description)) {
    keywordWeights[kw] = d.keywordBound((keywordWeights[kw] ?? 0) + d.keywordDelta);
  }
  return { topicWeights, sourceWeights, keywordWeights: trimKeywords(keywordWeights) };
}

export function upvote(article: Article, prefs: UserPrefs): UserPrefs {
  // Toggle: clicking again removes the upvote (no weight reversal — weights are soft signals)
  if (prefs.upvotedIds.includes(article.id)) {
    return { ...prefs, upvotedIds: prefs.upvotedIds.filter(id => id !== article.id) };
  }
  return {
    ...prefs,
    ...applyVoteWeights(article, prefs, UP_DELTAS),
    upvotedIds:   [...prefs.upvotedIds, article.id],
    downvotedIds: prefs.downvotedIds.filter(id => id !== article.id),
  };
}

export function downvote(article: Article, prefs: UserPrefs): UserPrefs {
  // Toggle: clicking again removes the downvote
  if (prefs.downvotedIds.includes(article.id)) {
    return { ...prefs, downvotedIds: prefs.downvotedIds.filter(id => id !== article.id) };
  }
  return {
    ...prefs,
    ...applyVoteWeights(article, prefs, DOWN_DELTAS),
    downvotedIds: [...prefs.downvotedIds, article.id],
    upvotedIds:   prefs.upvotedIds.filter(id => id !== article.id),
  };
}

// ── Weight decay ──────────────────────────────────────────────────────────────
// Call on session start. If 7+ days have passed, nudge weights back toward
// neutral so old preferences don't lock in forever.

const DAYS_PER_WEEK = 7;
const DECAY_INTERVAL = DAYS_PER_WEEK * 24 * 60 * 60 * 1000;

export function applyDecay(prefs: UserPrefs): UserPrefs {
  if (Date.now() - prefs.lastDecayAt < DECAY_INTERVAL) return prefs;

  const topicWeights: Partial<Record<Topic, number>> = {};
  for (const [t, w] of Object.entries(prefs.topicWeights) as [Topic, number][]) {
    topicWeights[t] = w + (1.0 - w) * DECAY_DRIFT_RATE;
  }

  const sourceWeights: Record<string, number> = {};
  for (const [src, w] of Object.entries(prefs.sourceWeights)) {
    sourceWeights[src] = w + (1.0 - w) * DECAY_DRIFT_RATE;
  }

  const keywordWeights: Record<string, number> = {};
  for (const [kw, w] of Object.entries(prefs.keywordWeights)) {
    keywordWeights[kw] = w * KEYWORD_DECAY_FACTOR;
  }

  return { ...prefs, topicWeights, sourceWeights, keywordWeights, lastDecayAt: Date.now() };
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
    const lines = customSources.map(s => toOutline(s.name, s.feedUrl, s.id, ` boomerangCustom="true" boomerangId="${escapeXml(s.id)}"`));
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

    const opmlEntries = new Map<string, { disabled: boolean; custom: boolean; name: string; id: string | null }>();
    for (const el of outlines) {
      const xmlUrl = el.getAttribute('xmlUrl')?.trim();
      if (!xmlUrl) continue;
      opmlEntries.set(xmlUrl, {
        disabled: el.getAttribute('boomerangDisabled') === 'true',
        custom:   el.getAttribute('boomerangCustom')   === 'true',
        name:     el.getAttribute('text') || el.getAttribute('title') || xmlUrl,
        id:       el.getAttribute('boomerangId'),
      });
    }

    const defaultUrlSet = new Set(defaultSources.map(s => s.feedUrl));

    // Built-in sources not in OPML, or explicitly disabled → go into disabledSourceIds
    const newDisabledIds: string[] = [];
    for (const s of defaultSources) {
      const entry = opmlEntries.get(s.feedUrl);
      if (!entry || entry.disabled) newDisabledIds.push(s.id);
    }

    // URLs not matching any built-in source → custom sources.
    // Ids come from boomerangId when present, else derive a stable id from
    // the URL — so an export→import round trip preserves source identity and
    // honors boomerangDisabled instead of silently re-enabling feeds.
    const newCustomSources: CustomSource[] = [];
    for (const [url, { name, disabled, id }] of opmlEntries) {
      if (defaultUrlSet.has(url)) continue;
      const sourceId = id ?? customSourceIdFromUrl(url);
      newCustomSources.push({ id: sourceId, name, feedUrl: url });
      if (disabled) newDisabledIds.push(sourceId);
    }

    return { disabledSourceIds: newDisabledIds, customSources: newCustomSources };
  } catch {
    return null;
  }
}

// ── Browser bookmarks export / import ─────────────────────────────────────────

const BASE36_RADIX = 36;

function hashUrl(url: string): string {
  let h = 0;
  for (let i = 0; i < url.length; i++) { h = Math.imul(HASH_PRIME, h) + url.charCodeAt(i) | 0; }
  return (h >>> 0).toString(BASE36_RADIX);
}

/** Stable custom-source id from the feed URL — repeat imports stay idempotent. */
export function customSourceIdFromUrl(url: string): string {
  return `custom-${hashUrl(url)}`;
}

function bmId(url: string): string {
  return `bm-${hashUrl(url)}`;
}

/** Export saved articles as a Netscape HTML bookmarks file. */
export function exportBookmarkHTML(articles: Article[]): string {
  const items = articles.map(a => {
    const ts = Math.floor(a.publishedAt.getTime() / MS_PER_SECOND);
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
      const ts      = addDate ? parseInt(addDate, 10) * MS_PER_SECOND : Date.now();
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
