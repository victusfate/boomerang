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
const CACHE_TTL = 15 * 60 * 1000;   // 15 minutes — refresh if older
const PREFS_ID  = 'user-prefs';
const CACHE_ID  = 'feed-cache';

// Articles are stored with publishedAt as ISO string in Fireproof
type StoredArticle = Omit<Article, 'publishedAt'> & { publishedAt: string };
interface FeedCacheDoc { _id: string; articles: StoredArticle[]; fetchedAt: number }
type PrefsDoc = UserPrefs & { _id: string };

function hydrate(stored: StoredArticle[]): Article[] {
  return stored.map(a => ({ ...a, publishedAt: new Date(a.publishedAt) }));
}
function dehydrate(articles: Article[]): StoredArticle[] {
  return articles.map(a => ({ ...a, publishedAt: a.publishedAt.toISOString() }));
}

export function useFeed() {
  const { database } = useFireproof('boomerang-news');

  const [prefs, setPrefsState]     = useState<UserPrefs>(DEFAULT_PREFS);
  const [prefsReady, setPrefsReady] = useState(false);

  const [allArticles, setAllArticles] = useState<Article[]>([]);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const [loading, setLoading]         = useState(true);
  const [refreshing, setRefreshing]   = useState(false); // background refresh over cache
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const prefsRef        = useRef(prefs);
  prefsRef.current      = prefs;
  const markedSeenRef   = useRef(new Set<string>());
  const timerRef        = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Persist prefs ────────────────────────────────────────────────────────────
  const updatePrefs = useCallback((next: UserPrefs) => {
    setPrefsState(next);
    database.put({ _id: PREFS_ID, ...next } as PrefsDoc).catch(console.error);
  }, [database]);

  // ── Load prefs + cache from Fireproof in parallel on mount ───────────────────
  useEffect(() => {
    const prefsPromise = database.get<PrefsDoc>(PREFS_ID)
      .then(doc => setPrefsState({ ...DEFAULT_PREFS, ...doc }))
      .catch(() => {});                  // no stored prefs yet — defaults are fine

    const cachePromise = database.get<FeedCacheDoc>(CACHE_ID)
      .then(cache => {
        if (!cache.articles?.length) return null;
        return { articles: hydrate(cache.articles), fetchedAt: cache.fetchedAt };
      })
      .catch(() => null);               // no cache yet

    Promise.all([prefsPromise, cachePromise]).then(([, cached]) => {
      setPrefsReady(true);
      if (cached?.articles.length) {
        // Apply seenIds filter with the just-loaded prefs
        const p = prefsRef.current;
        const seen = new Set([...p.seenIds, ...p.readIds]);
        const fresh = cached.articles.filter(a => !seen.has(a.id));
        if (fresh.length) {
          setAllArticles(rankFeed(fresh, p));
          setLoading(false);
        }
        // Skip network refresh if cache is still warm
        const stale = Date.now() - cached.fetchedAt > CACHE_TTL;
        if (!stale) setLastRefresh(new Date(cached.fetchedAt));
      }
    });
  }, [database]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Network refresh ──────────────────────────────────────────────────────────
  const refresh = useCallback(async (currentPrefs: UserPrefs) => {
    const hasCached = allArticles.length > 0;
    if (hasCached) setRefreshing(true); else setLoading(true);
    setError(null);

    const activeSources = DEFAULT_SOURCES.filter(s => isSourceEnabled(s.id, currentPrefs));
    const seen = new Set([...currentPrefs.seenIds, ...currentPrefs.readIds]);

    // Streaming: re-rank and show as each source resolves
    const onBatch = (accumulated: Article[]) => {
      const ranked = rankFeed(accumulated, currentPrefs);
      setAllArticles(ranked);
      if (loading) setLoading(false);
      if (refreshing) setRefreshing(false);
    };

    try {
      const all = await fetchAllSources(activeSources, onBatch);
      if (all.length === 0) {
        setError('No articles loaded. Check your connection and try again.');
      } else {
        const ranked = rankFeed(all, currentPrefs);
        setAllArticles(ranked);
        setVisibleCount(PAGE_SIZE);
        markedSeenRef.current.clear();
        // Persist to Fireproof cache (store unseen articles for next cold start)
        const toCache = all.filter(a => !seen.has(a.id));
        database.put({ _id: CACHE_ID, articles: dehydrate(toCache), fetchedAt: Date.now() })
          .catch(console.error);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load feed');
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLastRefresh(new Date());
    }
  }, [allArticles.length, database, loading, refreshing]);

  // ── Trigger refresh once prefs are loaded (skip if cache was fresh) ───────────
  useEffect(() => {
    if (!prefsReady) return;
    // If we already set lastRefresh from a warm cache, don't re-fetch yet
    if (lastRefresh && Date.now() - lastRefresh.getTime() < CACHE_TTL) return;
    refresh(prefsRef.current);
  }, [prefsReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-refresh timer ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!lastRefresh) return;
    timerRef.current = setTimeout(() => refresh(prefsRef.current), CACHE_TTL);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [lastRefresh, refresh]);

  // ── Mark articles as seen when they enter the visible window ─────────────────
  useEffect(() => {
    if (allArticles.length === 0) return;
    const batch = allArticles.slice(0, visibleCount);
    const freshIds = batch.map(a => a.id).filter(id => !markedSeenRef.current.has(id));
    if (freshIds.length === 0) return;
    freshIds.forEach(id => markedSeenRef.current.add(id));
    updatePrefs(markSeen(freshIds, prefsRef.current));
  }, [visibleCount, allArticles, updatePrefs]);

  // ── Pagination ────────────────────────────────────────────────────────────────
  const loadMore = useCallback(() => {
    if (loadingMore) return;
    setLoadingMore(true);
    setTimeout(() => {
      setVisibleCount(prev => Math.min(prev + PAGE_SIZE, allArticles.length));
      setLoadingMore(false);
    }, 150);
  }, [loadingMore, allArticles.length]);

  // ── Article interactions ──────────────────────────────────────────────────────
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
    hasMore:     visibleCount < allArticles.length,
    totalLoaded: allArticles.length,
    loading,
    refreshing,
    loadingMore,
    error,
    prefs,
    lastRefresh,
    onOpen:           handleOpen,
    onSave:           handleSave,
    onLoadMore:       loadMore,
    onToggleSource:   handleToggleSource,
    onToggleTopic:    handleToggleTopic,
    onRefresh:        handleRefresh,
  };
}
