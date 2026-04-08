import type { Topic, UserPrefs } from '../types';

const STORAGE_KEY = 'boomerang_news_prefs';

const DEFAULT_PREFS: UserPrefs = {
  topicWeights: {},
  sourceWeights: {},
  readIds: [],
  savedIds: [],
  seenIds: [],
  enabledSources: [],   // empty = all enabled
  enabledTopics: [],    // empty = all enabled
};

export function loadPrefs(): UserPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs: UserPrefs): void {
  // Cap lists to avoid storage bloat
  const trimmed = {
    ...prefs,
    readIds: prefs.readIds.slice(-500),
    seenIds: prefs.seenIds.slice(-2000),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
}

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
