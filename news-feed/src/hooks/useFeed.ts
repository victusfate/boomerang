import { useCallback, useEffect, useRef, useState } from 'react';
import { useFireproof } from 'use-fireproof';
import { fetchAllSources, DEFAULT_SOURCES } from '../services/newsService';
import { rankFeed } from '../services/algorithm';
import {
  DEFAULT_PREFS,
  markRead, markSeen, toggleSaved,
  boostTopic, toggleSource, toggleTopic, isSourceEnabled,
  upvote, downvote, applyDecay, resetLearnedWeights, clearViewedCache,
  addCustomSource, removeCustomSource, importPrefsBookmark,
  mergePoolWithSavedSnapshots, exportOPML, importOPML,
} from '../services/storage';
import type { Article, CustomSource, Topic, UserPrefs } from '../types';

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

/** Survives React Strict Mode remount so we don't double-fetch after #bm= import */
declare global {
  interface Window {
    __boomerangSkipInitialRefresh?: boolean;
  }
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
  /** Bookmark v2 snapshots — merged into the pool after fetch so Saved works in a fresh profile */
  const pendingSavedSnapshotsRef = useRef<Map<string, Article>>(new Map());

  // ── Persist prefs ────────────────────────────────────────────────────────────
  const updatePrefs = useCallback((next: UserPrefs) => {
    setPrefsState(next);
    database.put({ _id: PREFS_ID, ...next } as PrefsDoc).catch(console.error);
  }, [database]);

  // ── Load prefs + cache from Fireproof on mount ────────────────────────────────
  useEffect(() => {
    const prefsPromise = database.get<PrefsDoc>(PREFS_ID)
      .then(doc => {
        let merged: UserPrefs = { ...DEFAULT_PREFS, ...doc };
        // One-time migration: old whitelist `enabledSources` → blacklist `disabledSourceIds`
        if ((merged.enabledSources?.length ?? 0) > 0 && (merged.disabledSourceIds?.length ?? 0) === 0) {
          const enabledSet = new Set(merged.enabledSources);
          merged = {
            ...merged,
            disabledSourceIds: DEFAULT_SOURCES.map(s => s.id).filter(id => !enabledSet.has(id)),
            enabledSources: [],
          };
        }
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

    const activeSources       = DEFAULT_SOURCES.filter(s => isSourceEnabled(s.id, currentPrefs));
    const activeCustomSources = (currentPrefs.customSources ?? []).filter(s => isSourceEnabled(s.id, currentPrefs));

    // Merges ranked articles into the feed without collapsing the current visible list.
    // On explicit refresh the feed is fully replaced; on background refresh only
    // genuinely new articles (not already in the current feed) are prepended.
    const mergeFeed = (ranked: Article[]) => {
      if (explicit || allArticlesRef.current.length === 0) {
        allArticlesRef.current = ranked;
        setAllArticles(ranked);
      } else {
        const currentIds = new Set(allArticlesRef.current.map(a => a.id));
        const brandNew = ranked.filter(a => !currentIds.has(a.id));
        const merged = [...brandNew, ...allArticlesRef.current];
        allArticlesRef.current = merged;
        setAllArticles(merged);
      }
    };

    const onBatch = (accumulated: Article[]) => {
      if (fetchIdRef.current !== myFetchId) return; // stale fetch — discard
      const merged = mergePoolWithSavedSnapshots(
        accumulated,
        currentPrefs.savedIds,
        pendingSavedSnapshotsRef.current,
      );
      articlePoolRef.current = merged;
      setArticlePool(merged);
      const ranked = rankFeed(merged, currentPrefs);
      mergeFeed(ranked);
      setLoading(false);
    };

    let feedSuccess = false;
    try {
      const all = await fetchAllSources(activeSources, activeCustomSources, onBatch);
      if (fetchIdRef.current !== myFetchId) return; // superseded — bail out

      const merged = mergePoolWithSavedSnapshots(all, currentPrefs.savedIds, pendingSavedSnapshotsRef.current);

      if (merged.length === 0) {
        const hadPool = articlePoolRef.current.length > 0;
        setError(
          hadPool
            ? 'Feed service returned no articles — showing cached list below.'
            : 'No articles loaded. Check your connection and try again.',
        );
      } else {
        pendingSavedSnapshotsRef.current.clear();
        feedSuccess = true;
        setError(null);
        articlePoolRef.current = merged;
        setArticlePool(merged);
        const ranked = rankFeed(merged, currentPrefs);
        mergeFeed(ranked);
        // On explicit refresh also reset scroll and seen-session tracking
        if (explicit) {
          setVisibleCount(PAGE_SIZE);
          markedSeenRef.current.clear();
        }
        database.put({ _id: CACHE_ID, articles: dehydrate(merged), fetchedAt: Date.now() })
          .catch(console.error);
      }
    } catch (e) {
      if (fetchIdRef.current === myFetchId) {
        const hadPool = articlePoolRef.current.length > 0;
        const detail = e instanceof Error ? e.message : 'Failed to load feed';
        setError(
          hadPool
            ? `Could not refresh — the list below is cached from an earlier load. ${detail}`
            : detail,
        );
      }
    } finally {
      if (fetchIdRef.current === myFetchId) {
        setLoading(false);
        setRefreshing(false);
        setFetching(false);
        if (feedSuccess) {
          setLastRefresh(new Date());
        }
        fetchingRef.current = false;
      } else {
        fetchingRef.current = false;
      }
    }
  }, [database]); // stable — does not depend on volatile state

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

  // ── Mark a single article as seen after the user has dwelt on it ─────────────
  // Called by ArticleCard via IntersectionObserver + dwell timer (see ArticleCard.tsx).
  const handleSeen = useCallback((id: string) => {
    if (markedSeenRef.current.has(id)) return; // already counted this session
    markedSeenRef.current.add(id);
    setPrefsState(prev => {
      const next = markSeen([id], prev);
      database.put({ _id: PREFS_ID, ...next } as PrefsDoc).catch(console.error);
      return next;
    });
  }, [database]);

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
    updatePrefs(upvote(article, prefsRef.current));
    // No re-rank: card stays visible; ▲ highlight comes from prefs.upvotedIds.
  }, [updatePrefs]);

  const handleDownvote = useCallback((article: Article) => {
    updatePrefs(downvote(article, prefsRef.current));
    // Splice out only the downvoted card — avoid rankFeed(pool) which would also
    // filter seenIds and collapse the rest of the visible feed.
    setAllArticles(prev => prev.filter(a => a.id !== article.id));
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

  // ── Custom sources ────────────────────────────────────────────────────────────
  const handleAddCustomSource = useCallback((source: CustomSource) => {
    const next = addCustomSource(source, prefsRef.current);
    updatePrefs(next);
    fetchIdRef.current++;
    fetchingRef.current = false;
    refresh(next, false); // background merge — prepend new articles
  }, [updatePrefs, refresh]);

  const handleRemoveCustomSource = useCallback((id: string) => {
    const next = removeCustomSource(id, prefsRef.current);
    updatePrefs(next);
    fetchIdRef.current++;
    fetchingRef.current = false;
    refresh(next, true); // explicit — re-rank without removed source's articles
  }, [updatePrefs, refresh]);

  // ── Bookmark import (internal — used only for #bm= URL hash restore) ────────
  const handleImportBookmark = useCallback((encoded: string): boolean => {
    // Accept either a full URL (extract hash) or a bare base64 string
    let b64 = encoded.trim();
    try {
      const hashIdx = b64.indexOf('#bm=');
      if (hashIdx !== -1) b64 = b64.slice(hashIdx + 4);
    } catch { /* not a URL — use as-is */ }
    const imported = importPrefsBookmark(b64);
    if (!imported) return false;
    const { prefs: importedPrefs, savedSnapshots } = imported;
    const next: UserPrefs = { ...DEFAULT_PREFS, ...prefsRef.current, ...importedPrefs };
    if (savedSnapshots?.length) {
      pendingSavedSnapshotsRef.current.clear();
      for (const s of savedSnapshots) {
        const a: Article = { ...s, publishedAt: new Date(s.publishedAt) };
        pendingSavedSnapshotsRef.current.set(a.id, a);
      }
    }
    updatePrefs(next);
    fetchIdRef.current++;
    fetchingRef.current = false;
    refresh(next, true);
    return true;
  }, [updatePrefs, refresh]);

  const handleImportBookmarkRef = useRef(handleImportBookmark);
  handleImportBookmarkRef.current = handleImportBookmark;

  // ── OPML export / import ──────────────────────────────────────────────────────
  const handleExportOPML = useCallback(() => {
    const { disabledSourceIds = [], customSources = [] } = prefsRef.current;
    const xml = exportOPML(DEFAULT_SOURCES, customSources, disabledSourceIds);
    const blob = new Blob([xml], { type: 'application/xml' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'boomerang-feeds.opml';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  const handleImportOPML = useCallback((xml: string): boolean => {
    const result = importOPML(xml, DEFAULT_SOURCES);
    if (!result) return false;
    const next: UserPrefs = {
      ...prefsRef.current,
      disabledSourceIds: result.disabledSourceIds,
      customSources: result.customSources,
    };
    updatePrefs(next);
    fetchIdRef.current++;
    fetchingRef.current = false;
    refresh(next, true);
    return true;
  }, [updatePrefs, refresh]);

  // Restore from bookmark URL hash on load (opening …#bm=… in a private window / new profile)
  useEffect(() => {
    if (!prefsReady) return;
    if (!window.location.hash.startsWith('#bm=')) return;
    const ok = handleImportBookmarkRef.current(window.location.href);
    if (ok) window.__boomerangSkipInitialRefresh = true;
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, [prefsReady]);

  // Trigger refresh once prefs are ready (skipped when #bm= import already invoked refresh)
  useEffect(() => {
    if (!prefsReady) return;
    if (window.__boomerangSkipInitialRefresh) {
      window.__boomerangSkipInitialRefresh = false;
      return;
    }
    if (lastRefresh && Date.now() - lastRefresh.getTime() < CACHE_TTL) return;
    refresh(prefsRef.current);
  }, [prefsReady, refresh, lastRefresh]);

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
    onSeen:         handleSeen,
    onLoadMore:     loadMore,
    onToggleSource:      handleToggleSource,
    onToggleTopic:       handleToggleTopic,
    onResetPrefs:        handleResetPrefs,
    onClearViewed:       handleClearViewed,
    onRefresh:           handleRefresh,
    onAddCustomSource:    handleAddCustomSource,
    onRemoveCustomSource: handleRemoveCustomSource,
    onExportOPML:         handleExportOPML,
    onImportOPML:         handleImportOPML,
  };
}
