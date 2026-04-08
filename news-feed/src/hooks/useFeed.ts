import { useCallback, useEffect, useRef, useState } from 'react';
import { useFireproof } from 'use-fireproof';
import { fetchAllSources, DEFAULT_SOURCES } from '../services/newsService';
import { rankFeed } from '../services/algorithm';
import {
  DEFAULT_PREFS,
  markRead, markSeen, toggleSaved,
  boostTopic, toggleSource, toggleTopic, isSourceEnabled,
} from '../services/storage';
import type { Article, Topic, UserPrefs } from '../types';

const PAGE_SIZE = 5;
const REFRESH_INTERVAL = 15 * 60 * 1000; // 15 minutes
const PREFS_DOC_ID = 'user-prefs';

type PrefsDoc = UserPrefs & { _id: string };

export function useFeed() {
  const { database } = useFireproof('boomerang-news');

  // Prefs loaded from Fireproof; starts at defaults until the async get resolves
  const [prefs, setPrefsState] = useState<UserPrefs>(DEFAULT_PREFS);
  const [prefsLoaded, setPrefsLoaded] = useState(false);

  // Full ranked list for this session (filtered by seenIds at load time)
  const [allArticles, setAllArticles] = useState<Article[]>([]);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  // Stable ref so effects/callbacks always read the latest prefs without re-running
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  // Track IDs already marked seen this session to avoid duplicate DB writes
  const markedSeenRef = useRef(new Set<string>());

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load prefs from Fireproof on mount
  useEffect(() => {
    database.get<PrefsDoc>(PREFS_DOC_ID)
      .then(doc => {
        setPrefsState({ ...DEFAULT_PREFS, ...doc });
      })
      .catch(() => {
        // No stored prefs yet — defaults are fine
      })
      .finally(() => {
        setPrefsLoaded(true);
      });
  }, [database]);

  // Persist prefs back to Fireproof and update React state
  const updatePrefs = useCallback((next: UserPrefs) => {
    setPrefsState(next);
    database.put({ _id: PREFS_DOC_ID, ...next } as PrefsDoc).catch(console.error);
  }, [database]);

  const refresh = useCallback(async (currentPrefs: UserPrefs) => {
    setLoading(true);
    setError(null);
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

  // Initial load — wait until Fireproof prefs have been loaded so seenIds/source
  // filters are correct before the first fetch
  useEffect(() => {
    if (!prefsLoaded) return;
    refresh(prefsRef.current);
  }, [prefsLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh timer
  useEffect(() => {
    if (!lastRefresh) return;
    timerRef.current = setTimeout(() => refresh(prefsRef.current), REFRESH_INTERVAL);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [lastRefresh, refresh]);

  // Mark articles as seen when they enter the visible window
  useEffect(() => {
    if (allArticles.length === 0) return;
    const batch = allArticles.slice(0, visibleCount);
    const freshIds = batch.map(a => a.id).filter(id => !markedSeenRef.current.has(id));
    if (freshIds.length === 0) return;

    freshIds.forEach(id => markedSeenRef.current.add(id));
    updatePrefs(markSeen(freshIds, prefsRef.current));
  }, [visibleCount, allArticles, updatePrefs]);

  const loadMore = useCallback(() => {
    if (loadingMore) return;
    setLoadingMore(true);
    setTimeout(() => {
      setVisibleCount(prev => Math.min(prev + PAGE_SIZE, allArticles.length));
      setLoadingMore(false);
    }, 150);
  }, [loadingMore, allArticles.length]);

  const handleOpen = useCallback((article: Article) => {
    const next = markRead(article.id, prefsRef.current);
    const boosted = article.topics.reduce((p, t) => boostTopic(t, p), next);
    updatePrefs(boosted);
  }, [updatePrefs]);

  const handleSave = useCallback((id: string) => {
    updatePrefs(toggleSaved(id, prefsRef.current));
  }, [updatePrefs]);

  const handleToggleSource = useCallback((sourceId: string) => {
    const next = toggleSource(sourceId, prefsRef.current);
    updatePrefs(next);
    refresh(next);
  }, [updatePrefs, refresh]);

  const handleToggleTopic = useCallback((topic: Topic) => {
    updatePrefs(toggleTopic(topic, prefsRef.current));
  }, [updatePrefs]);

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
