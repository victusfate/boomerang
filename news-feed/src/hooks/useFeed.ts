import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchAllSources, DEFAULT_SOURCES } from '../services/newsService';
import { rankFeed } from '../services/algorithm';
import {
  loadPrefs, savePrefs, markRead, markSeen, toggleSaved,
  boostTopic, toggleSource, toggleTopic, isSourceEnabled,
} from '../services/storage';
import type { Article, Topic, UserPrefs } from '../types';

const PAGE_SIZE = 5;
const REFRESH_INTERVAL = 15 * 60 * 1000; // 15 minutes

export function useFeed() {
  // Full ranked list for this session (filtered by seenIds at load time)
  const [allArticles, setAllArticles] = useState<Article[]>([]);
  // How many articles are currently visible in the feed
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prefs, setPrefsState] = useState<UserPrefs>(loadPrefs);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  // Always-current prefs ref — used in effects that shouldn't re-run when prefs change
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  // Track which IDs we've already marked seen in this session to avoid duplicate writes
  const markedSeenRef = useRef(new Set<string>());

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const updatePrefs = useCallback((next: UserPrefs) => {
    setPrefsState(next);
    savePrefs(next);
  }, []);

  const refresh = useCallback(async (currentPrefs: UserPrefs) => {
    setLoading(true);
    setError(null);
    // Reset pagination on each refresh
    setVisibleCount(PAGE_SIZE);
    markedSeenRef.current.clear();
    try {
      const activeSources = DEFAULT_SOURCES.filter(s => isSourceEnabled(s.id, currentPrefs));
      const raw = await fetchAllSources(activeSources);
      if (raw.length === 0) {
        setError('No articles loaded. Check your connection and try again.');
      }
      const ranked = rankFeed(raw, currentPrefs);
      setAllArticles(ranked);
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

  // Auto-refresh timer
  useEffect(() => {
    timerRef.current = setTimeout(() => refresh(prefsRef.current), REFRESH_INTERVAL);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [lastRefresh, refresh]);

  // Mark articles as seen when they enter the visible window
  // Uses prefsRef so this effect only re-runs when visibleCount/allArticles change
  useEffect(() => {
    if (allArticles.length === 0) return;
    const batch = allArticles.slice(0, visibleCount);
    const freshIds = batch
      .map(a => a.id)
      .filter(id => !markedSeenRef.current.has(id));
    if (freshIds.length === 0) return;

    freshIds.forEach(id => markedSeenRef.current.add(id));
    const newPrefs = markSeen(freshIds, prefsRef.current);
    updatePrefs(newPrefs);
  }, [visibleCount, allArticles, updatePrefs]);

  const loadMore = useCallback(() => {
    if (loadingMore) return;
    setLoadingMore(true);
    // Small delay gives the browser a frame to paint before adding more DOM nodes
    setTimeout(() => {
      setVisibleCount(prev => Math.min(prev + PAGE_SIZE, allArticles.length));
      setLoadingMore(false);
    }, 150);
  }, [loadingMore, allArticles.length]);

  const handleOpen = useCallback((article: Article) => {
    const next = markRead(article.id, prefs);
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

  const handleRefresh = useCallback(() => refresh(prefsRef.current), [refresh]);

  return {
    visibleArticles: allArticles.slice(0, visibleCount),
    hasMore: visibleCount < allArticles.length,
    totalLoaded: allArticles.length,
    loading,
    loadingMore,
    error,
    prefs,
    lastRefresh,
    onOpen: handleOpen,
    onSave: handleSave,
    onLoadMore: loadMore,
    onToggleSource: handleToggleSource,
    onToggleTopic: handleToggleTopic,
    onRefresh: handleRefresh,
  };
}
