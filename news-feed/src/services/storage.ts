// Pure utility functions for prefs manipulation.
// Persistence is handled by Fireproof in useFeed.ts.

import type { Article, Topic, UserPrefs } from '../types';

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
};

// ── Keyword extraction ────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the','and','for','with','that','this','from','have','will','been',
  'are','was','were','its','has','but','not','more','into','than','over',
  'also','about','after','their','they','said','when','what','which',
  'there','would','could','should','being','some','just',
]);

const MAX_KEYWORDS = 500; // cap stored entries — evict lowest-magnitude on overflow

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
  return { ...prefs, readIds: [...prefs.readIds, id] };
}

export function markSeen(ids: string[], prefs: UserPrefs): UserPrefs {
  const existing = new Set(prefs.seenIds);
  const fresh = ids.filter(id => !existing.has(id));
  if (fresh.length === 0) return prefs;
  return { ...prefs, seenIds: [...prefs.seenIds, ...fresh] };
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
