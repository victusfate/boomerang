import { useCallback, useEffect, useRef, useState } from 'react';
import { useFireproof } from 'use-fireproof';
import { fetchAllSources, DEFAULT_SOURCES } from '../services/newsService';
import { rankFeed } from '../services/algorithm';
import {
  DEFAULT_PREFS,
  markRead, markSeen, toggleSaved,
  boostTopic, toggleSource, toggleTopic, isSourceEnabled,
  upvote, downvote, applyDecay, resetLearnedWeights, clearViewedCache,
} from '../services/storage';
import type { Article, Topic, UserPrefs } from '../types';

const PAGE_SIZE   = 5;
const CACHE_TTL   = 15 * 60 * 1000;
const PREFS_ID    = 'user-prefs';
const CACHE_ID    = 'feed-cache';

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

  const [prefs, setPrefsState]      = useState<UserPrefs>(DEFAULT_PREFS);
  const [prefsReady, setPrefsReady] = useState(false);
  const [allArticles, setAllArticles] = useState<Article[]>([]);
  const [articlePool, setArticlePool] = useState<Article[]>([]);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [loading, setLoading]     = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [fetching, setFetching]   = useState(false);  // true for entire fetch duration
  const [error, setError]         = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  // ── Stable refs (avoid stale closures in `refresh`) ──────────────────────────
  const prefsRef         = useRef(prefs);
  prefsRef.current       = prefs;

  const articlePoolRef   = useRef<Article[]>([]);
  articlePoolRef.current = articlePool;

  const allArticlesRef   = useRef<Article[]>([]);
  allArticlesRef.current = allArticles;

  const markedSeenRef    = useRef(new Set<string>());
  const timerRef         = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Incremented on every refresh call; onBatch/finally checks this to discard
  // results from a superseded (stale) fetch.
  const fetchIdRef = useRef(0);
  // Prevents concurrent fetches from firing simultaneously.
  const fetchingRef = useRef(false);

  // ── Persist prefs ────────────────────────────────────────────────────────────
  const updatePrefs = useCallback((next: UserPrefs) => {
    setPrefsState(next);
    database.put({ _id: PREFS_ID, ...next } as PrefsDoc).catch(console.error);
  }, [database]);

  // ── Load prefs + cache from Fireproof on mount ────────────────────────────────
  useEffect(() => {
    const prefsPromise = database.get<PrefsDoc>(PREFS_ID)
      .then(doc => {
        const merged  = { ...DEFAULT_PREFS, ...doc };
        const decayed = applyDecay(merged);
        setPrefsState(decayed);
        if (decayed !== merged) {
          database.put({ _id: PREFS_ID, ...decayed } as PrefsDoc).catch(console.error);
        }
        return decayed;
      })
      .catch(() => DEFAULT_PREFS);

    const cachePromise = database.get<FeedCacheDoc>(CACHE_ID)
      .then(cache => cache.articles?.length
        ? { articles: hydrate(cache.articles), fetchedAt: cache.fetchedAt }
        : null)
      .catch(() => null);

    Promise.all([prefsPromise, cachePromise]).then(([loadedPrefs, cached]) => {
      setPrefsReady(true);

      if (cached?.articles.length) {
        articlePoolRef.current = cached.articles;
        setArticlePool(cached.articles);

        const ranked = rankFeed(cached.articles, loadedPrefs);
        allArticlesRef.current = ranked;
        setAllArticles(ranked);
        if (ranked.length) setLoading(false);

        // If saved articles are missing from cache (old format), force network refresh
        const cachedIds    = new Set(cached.articles.map(a => a.id));
        const missingSaved = loadedPrefs.savedIds.some(id => !cachedIds.has(id));
        const stale        = missingSaved || Date.now() - cached.fetchedAt > CACHE_TTL;
        if (!stale) setLastRefresh(new Date(cached.fetchedAt));
      }
    });
  }, [database]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Network refresh ───────────────────────────────────────────────────────────
  // Stable — only depends on `database`. All other values read via refs.
  const refresh = useCallback(async (currentPrefs: UserPrefs, explicit = false) => {
    if (fetchingRef.current) return;           // concurrent fetch guard
    fetchingRef.current = true;

    const myFetchId = ++fetchIdRef.current;    // mark this fetch generation

    const hasCached = allArticlesRef.current.length > 0;
    if (hasCached) setRefreshing(true); else setLoading(true);
    setFetching(true);
    setError(null);

    const activeSources = DEFAULT_SOURCES.filter(s => isSourceEnabled(s.id, currentPrefs));

    const onBatch = (accumulated: Article[]) => {
      if (fetchIdRef.current !== myFetchId) return; // stale fetch — discard
      articlePoolRef.current = accumulated;
      setArticlePool(accumulated);
      const ranked = rankFeed(accumulated, currentPrefs);
      allArticlesRef.current = ranked;
      setAllArticles(ranked);
      setLoading(false);
    };

    try {
      const all = await fetchAllSources(activeSources, onBatch);
      if (fetchIdRef.current !== myFetchId) return; // superseded — bail out

      if (all.length === 0) {
        setError('No articles loaded. Check your connection and try again.');
      } else {
        articlePoolRef.current = all;
        setArticlePool(all);
        const ranked = rankFeed(all, currentPrefs);
        allArticlesRef.current = ranked;
        setAllArticles(ranked);
        // Only reset scroll position on explicit user-triggered refresh
        if (explicit) {
          setVisibleCount(PAGE_SIZE);
          markedSeenRef.current.clear();
        }
        database.put({ _id: CACHE_ID, articles: dehydrate(all), fetchedAt: Date.now() })
          .catch(console.error);
      }
    } catch (e) {
      if (fetchIdRef.current === myFetchId) {
        setError(e instanceof Error ? e.message : 'Failed to load feed');
      }
    } finally {
      if (fetchIdRef.current === myFetchId) {
        setLoading(false);
        setRefreshing(false);
        setFetching(false);
        setLastRefresh(new Date());
        fetchingRef.current = false;
      } else {
        // This fetch was superseded; only release the lock if nobody else has it
        // (another fetch will manage its own lock release)
        fetchingRef.current = false;
      }
    }
  }, [database]); // stable — does not depend on volatile state

  // ── Trigger refresh once prefs are ready ─────────────────────────────────────
  useEffect(() => {
    if (!prefsReady) return;
    if (lastRefresh && Date.now() - lastRefresh.getTime() < CACHE_TTL) return;
    refresh(prefsRef.current);
  }, [prefsReady, refresh]);

  // ── Auto-refresh timer — uses stable `refresh` ref via timerRef ──────────────
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!lastRefresh) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(
      () => refreshRef.current(prefsRef.current),
      CACHE_TTL,
    );
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [lastRefresh]); // only reset timer when lastRefresh changes — not on refresh identity change

  // ── Mark articles as seen when they enter the visible window ─────────────────
  useEffect(() => {
    if (allArticles.length === 0) return;
    const batch    = allArticles.slice(0, visibleCount);
    const freshIds = batch.map(a => a.id).filter(id => !markedSeenRef.current.has(id));
    if (freshIds.length === 0) return;
    freshIds.forEach(id => markedSeenRef.current.add(id));
    // Use functional updater pattern to avoid concurrent lost-update race
    setPrefsState(prev => {
      const next = markSeen(freshIds, prev);
      database.put({ _id: PREFS_ID, ...next } as PrefsDoc).catch(console.error);
      return next;
    });
  }, [visibleCount, allArticles, database]);

  // ── Pagination ────────────────────────────────────────────────────────────────
  const loadMore = useCallback(() => {
    setVisibleCount(prev => {
      const total = allArticlesRef.current.length;
      if (prev >= total) return prev;
      return Math.min(prev + PAGE_SIZE, total);
    });
  }, []); // stable — reads allArticles via ref

  // ── Article interactions ──────────────────────────────────────────────────────
  const handleOpen = useCallback((article: Article) => {
    const next = markRead(article.id, prefsRef.current);
    const boosted = article.topics.reduce((p, t) => boostTopic(t, p), next);
    updatePrefs(boosted);
  }, [updatePrefs]);

  const handleSave = useCallback((id: string) => {
    updatePrefs(toggleSaved(id, prefsRef.current));
  }, [updatePrefs]);

  const handleUpvote = useCallback((article: Article) => {
    const next = upvote(article, prefsRef.current);
    updatePrefs(next);
    const pool = articlePoolRef.current;
    setAllArticles(prev => rankFeed(pool.length ? pool : prev, next));
  }, [updatePrefs]);

  const handleDownvote = useCallback((article: Article) => {
    const next = downvote(article, prefsRef.current);
    updatePrefs(next);
    const pool = articlePoolRef.current;
    setAllArticles(prev => rankFeed(pool.length ? pool : prev, next));
  }, [updatePrefs]);

  const handleToggleSource = useCallback((sourceId: string) => {
    const next = toggleSource(sourceId, prefsRef.current);
    updatePrefs(next);
    // Force a new fetch even if one is in progress by bumping fetchId first
    fetchIdRef.current++;
    fetchingRef.current = false;
    refresh(next, true);
  }, [updatePrefs, refresh]);

  const handleToggleTopic = useCallback((topic: Topic) => {
    updatePrefs(toggleTopic(topic, prefsRef.current));
  }, [updatePrefs]);

  const handleResetPrefs = useCallback(() => {
    const next = resetLearnedWeights(prefsRef.current);
    updatePrefs(next);
    const pool = articlePoolRef.current;
    setAllArticles(rankFeed(pool, next));
  }, [updatePrefs]);

  const handleClearViewed = useCallback(() => {
    const next = clearViewedCache(prefsRef.current);
    updatePrefs(next);
    markedSeenRef.current.clear();
    setVisibleCount(PAGE_SIZE);
    const pool = articlePoolRef.current;
    setAllArticles(rankFeed(pool, next));
  }, [updatePrefs]);

  const handleRefresh = useCallback(() => {
    // Explicit refresh: cancel any in-progress fetch and start fresh
    fetchIdRef.current++;
    fetchingRef.current = false;
    refresh(prefsRef.current, true);
  }, [refresh]);

  const savedArticles = articlePool.filter(a => prefs.savedIds.includes(a.id));

  return {
    visibleArticles: allArticles.slice(0, visibleCount),
    savedArticles,
    hasMore:     visibleCount < allArticles.length,
    totalLoaded: allArticles.length,
    loading,
    refreshing,
    fetching,
    error,
    prefs,
    lastRefresh,
    onOpen:         handleOpen,
    onSave:         handleSave,
    onUpvote:       handleUpvote,
    onDownvote:     handleDownvote,
    onLoadMore:     loadMore,
    onToggleSource: handleToggleSource,
    onToggleTopic:  handleToggleTopic,
    onResetPrefs:   handleResetPrefs,
    onClearViewed:  handleClearViewed,
    onRefresh:      handleRefresh,
  };
}
