import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchAllSources, DEFAULT_SOURCES } from '../services/newsService';
import { rankFeed } from '../services/algorithm';
import {
  loadPrefs, savePrefs, markRead, toggleSaved,
  boostTopic, toggleSource, toggleTopic, isSourceEnabled,
} from '../services/storage';
import type { Article, Topic, UserPrefs } from '../types';

const REFRESH_INTERVAL = 15 * 60 * 1000; // 15 minutes

export function useFeed() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [prefs, setPrefsState] = useState<UserPrefs>(loadPrefs);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const updatePrefs = useCallback((next: UserPrefs) => {
    setPrefsState(next);
    savePrefs(next);
  }, []);

  const refresh = useCallback(async (currentPrefs: UserPrefs) => {
    setLoading(true);
    setError(null);
    try {
      const activeSources = DEFAULT_SOURCES.filter(s => isSourceEnabled(s.id, currentPrefs));
      const raw = await fetchAllSources(activeSources);
      const ranked = rankFeed(raw, currentPrefs);
      setArticles(ranked);
      setLastRefresh(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load feed');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    refresh(prefs);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh
  useEffect(() => {
    timerRef.current = setTimeout(() => refresh(prefs), REFRESH_INTERVAL);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [lastRefresh, prefs, refresh]);

  const handleOpen = useCallback((article: Article) => {
    const next = markRead(article.id, prefs);
    // Boost topics for articles the user clicks
    const boosted = article.topics.reduce((p, t) => boostTopic(t, p), next);
    updatePrefs(boosted);
  }, [prefs, updatePrefs]);

  const handleSave = useCallback((id: string) => {
    updatePrefs(toggleSaved(id, prefs));
  }, [prefs, updatePrefs]);

  const handleToggleSource = useCallback((sourceId: string) => {
    const next = toggleSource(sourceId, prefs);
    updatePrefs(next);
    refresh(next);
  }, [prefs, updatePrefs, refresh]);

  const handleToggleTopic = useCallback((topic: Topic) => {
    updatePrefs(toggleTopic(topic, prefs));
  }, [prefs, updatePrefs]);

  const handleRefresh = useCallback(() => refresh(prefs), [prefs, refresh]);

  return {
    articles,
    loading,
    error,
    prefs,
    lastRefresh,
    onOpen: handleOpen,
    onSave: handleSave,
    onToggleSource: handleToggleSource,
    onToggleTopic: handleToggleTopic,
    onRefresh: handleRefresh,
  };
}
