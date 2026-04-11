// Pure utility functions for prefs manipulation.
// Persistence is handled by Fireproof in useFeed.ts.

import type { Article, CustomSource, Topic, UserPrefs } from '../types';

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
  enabledSources: [],   // empty = all enabled
  enabledTopics:  [],   // empty = all enabled
  customSources:  [],
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
  const enabled = prefs.enabledSources.includes(sourceId)
    ? prefs.enabledSources.filter(x => x !== sourceId)
    : [...prefs.enabledSources, sourceId];
  return { ...prefs, enabledSources: enabled };
}

export function toggleTopic(topic: Topic, prefs: UserPrefs): UserPrefs {
  const enabled = prefs.enabledTopics.includes(topic)
    ? prefs.enabledTopics.filter(x => x !== topic)
    : [...prefs.enabledTopics, topic];
  return { ...prefs, enabledTopics: enabled };
}

export function isSourceEnabled(sourceId: string, prefs: UserPrefs): boolean {
  return prefs.enabledSources.length === 0 || prefs.enabledSources.includes(sourceId);
}

export function isTopicEnabled(topic: Topic, prefs: UserPrefs): boolean {
  return prefs.enabledTopics.length === 0 || prefs.enabledTopics.includes(topic);
}

// ── Vote actions ──────────────────────────────────────────────────────────────

export function upvote(article: Article, prefs: UserPrefs): UserPrefs {
  if (prefs.upvotedIds.includes(article.id)) return prefs;

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
  if (prefs.downvotedIds.includes(article.id)) return prefs;

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
