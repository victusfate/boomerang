import { useCallback, useEffect, useRef, useState } from 'react';
import { useFireproof } from 'use-fireproof';
import { fetchAllSources, DEFAULT_SOURCES } from '../services/newsService';
import { rankFeed } from '../services/algorithm';
import {
  DEFAULT_PREFS,
  markRead, markSeen, toggleSaved,
  boostTopic, toggleSource, toggleTopic, isSourceEnabled,
  upvote, downvote, applyDecay, resetLearnedWeights, clearViewedCache,
  addCustomSource, removeCustomSource, exportOPML, importOPML,
  exportBookmarkHTML, importBookmarkHTML,
} from '../services/storage';
import type { Article, CustomSource, Topic, UserPrefs } from '../types';

const PAGE_SIZE          = 5;
const PREFS_ID           = 'user-prefs';
const CACHE_ID           = 'feed-cache';
const IMPORTED_SAVES_ID  = 'imported-saves';

type StoredArticle = Omit<Article, 'publishedAt'> & { publishedAt: string };
interface FeedCacheDoc    { _id: string; articles: StoredArticle[]; fetchedAt: number }
interface ImportedSavesDoc { _id: string; articles: StoredArticle[] }
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
  const [fetching, setFetching]   = useState(false);  // cleared on first batch or when fetch ends
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

  // Incremented on every refresh call; onBatch/finally checks this to discard
  // results from a superseded (stale) fetch.
  const fetchIdRef = useRef(0);
  // Prevents concurrent fetches from firing simultaneously.
  const fetchingRef = useRef(false);
  /** Article ids that just appended — short CSS enter animation (explicit progressive fetch). */
  const [feedEnterIds, setFeedEnterIds] = useState<string[]>([]);
  const feedEnterClearTimerRef = useRef<number | null>(null);

  // Bookmark-imported saves — kept separate from the RSS pool so they only
  // appear in the Saved view and never pollute the main feed.
  const [importedSaves, setImportedSaves] = useState<Article[]>([]);
  const importedSavesRef = useRef<Article[]>([]);
  importedSavesRef.current = importedSaves;

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

    const importedSavesPromise = database.get<ImportedSavesDoc>(IMPORTED_SAVES_ID)
      .then(doc => doc.articles?.length ? hydrate(doc.articles) : [])
      .catch(() => [] as Article[]);

    Promise.all([prefsPromise, cachePromise, importedSavesPromise]).then(([loadedPrefs, cached, imported]) => {
      if (imported.length) {
        importedSavesRef.current = imported;
        setImportedSaves(imported);
      }
      setPrefsReady(true);

      if (cached?.articles.length) {
        articlePoolRef.current = cached.articles;
        setArticlePool(cached.articles);

        const ranked = rankFeed(cached.articles, loadedPrefs);
        allArticlesRef.current = ranked;
        setAllArticles(ranked);
        if (ranked.length) setLoading(false);

        // Mark cache as valid so we skip the auto-fetch on startup
        setLastRefresh(new Date(cached.fetchedAt));
      }
    });
  }, [database]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => {
    if (feedEnterClearTimerRef.current) clearTimeout(feedEnterClearTimerRef.current);
  }, []);

  // ── Network refresh ───────────────────────────────────────────────────────────
  // Stable — only depends on `database`. All other values read via refs.
  const refresh = useCallback(async (currentPrefs: UserPrefs, explicit = false) => {
    if (fetchingRef.current) return;           // concurrent fetch guard
    fetchingRef.current = true;

    const myFetchId = ++fetchIdRef.current;    // mark this fetch generation

    const hadArticles = allArticlesRef.current.length > 0;
    // Explicit refresh: clear list so progressive batches don't re-rank the whole feed each time.
    if (explicit) {
      allArticlesRef.current = [];
      setAllArticles([]);
      setLoading(true);
    } else if (hadArticles) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setFetching(true);
    setError(null);

    const activeSources       = DEFAULT_SOURCES.filter(s => isSourceEnabled(s.id, currentPrefs));
    const activeCustomSources = (currentPrefs.customSources ?? []).filter(s => isSourceEnabled(s.id, currentPrefs));

    /** Preserve existing card order; enrich from ranked; append only ids not yet shown (no full re-sort). */
    const mergeIncrementalAppend = (ranked: Article[]) => {
      const prev = allArticlesRef.current;
      const prevIds = new Set(prev.map(a => a.id));
      const rankedById = new Map(ranked.map(a => [a.id, a]));
      const kept = prev.filter(a => rankedById.has(a.id)).map(a => rankedById.get(a.id)!);
      const newOnes = ranked.filter(a => !prevIds.has(a.id));
      allArticlesRef.current = [...kept, ...newOnes];
      setAllArticles([...kept, ...newOnes]);
      if (newOnes.length > 0 && prev.length > 0) {
        if (feedEnterClearTimerRef.current) clearTimeout(feedEnterClearTimerRef.current);
        setFeedEnterIds(newOnes.map(a => a.id));
        feedEnterClearTimerRef.current = window.setTimeout(() => {
          feedEnterClearTimerRef.current = null;
          setFeedEnterIds([]);
        }, 550);
      }
    };

    /** Background refresh: prepend genuinely new stories; keep prior rows stable. */
    const mergeFeedBackground = (ranked: Article[]) => {
      if (allArticlesRef.current.length === 0) {
        allArticlesRef.current = ranked;
        setAllArticles(ranked);
        return;
      }
      const currentIds = new Set(allArticlesRef.current.map(a => a.id));
      const brandNew = ranked.filter(a => !currentIds.has(a.id));
      const merged = [...brandNew, ...allArticlesRef.current];
      allArticlesRef.current = merged;
      setAllArticles(merged);
    };

    const applyRankedBatch = (accumulated: Article[]) => {
      const ranked = rankFeed(accumulated, currentPrefs);
      if (explicit) mergeIncrementalAppend(ranked);
      else mergeFeedBackground(ranked);
    };

    const onBatch = (accumulated: Article[]) => {
      if (fetchIdRef.current !== myFetchId) return; // stale fetch — discard
      const apply = () => {
        if (fetchIdRef.current !== myFetchId) return;
        articlePoolRef.current = accumulated;
        setArticlePool(accumulated);
        applyRankedBatch(accumulated);
        setLoading(false);
        if (accumulated.length > 0) {
          setRefreshing(false);
          setFetching(false);
        }
      };
      if (typeof requestAnimationFrame !== 'undefined') {
        requestAnimationFrame(() => apply());
      } else {
        apply();
      }
    };

    let feedSuccess = false;
    try {
      const all = await fetchAllSources(activeSources, activeCustomSources, onBatch);
      if (fetchIdRef.current !== myFetchId) return; // superseded — bail out

      if (all.length === 0) {
        const hadPool = articlePoolRef.current.length > 0;
        setError(
          hadPool
            ? 'Feed service returned no articles — showing cached list below.'
            : 'No articles loaded. Check your connection and try again.',
        );
      } else {
        feedSuccess = true;
        setError(null);
        articlePoolRef.current = all;
        setArticlePool(all);
        applyRankedBatch(all);
        // On explicit refresh also reset scroll and seen-session tracking
        if (explicit) {
          setVisibleCount(PAGE_SIZE);
          markedSeenRef.current.clear();
        }
        database.put({ _id: CACHE_ID, articles: dehydrate(all), fetchedAt: Date.now() })
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
    // Toggle downvote — card stays in the feed and renders collapsed via prefs.downvotedIds
    updatePrefs(downvote(article, prefsRef.current));
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

  // ── Bookmark HTML export / import ────────────────────────────────────────────
  const handleExportBookmarks = useCallback(() => {
    const poolIds = new Set(articlePoolRef.current.map(a => a.id));
    const allSaved = [
      ...articlePoolRef.current.filter(a => prefsRef.current.savedIds.includes(a.id)),
      ...importedSavesRef.current.filter(
        a => prefsRef.current.savedIds.includes(a.id) && !poolIds.has(a.id),
      ),
    ];
    const html = exportBookmarkHTML(allSaved);
    const blob = new Blob([html], { type: 'text/html' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'boomerang-saves.html';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  const handleImportBookmarks = useCallback((html: string): boolean => {
    const parsed = importBookmarkHTML(html);
    if (!parsed) return false;
    // Merge with existing imported saves, deduplicating by ID
    const existing = new Map(importedSavesRef.current.map(a => [a.id, a]));
    for (const a of parsed) existing.set(a.id, a);
    const merged = Array.from(existing.values());
    importedSavesRef.current = merged;
    setImportedSaves(merged);
    database.put({ _id: IMPORTED_SAVES_ID, articles: dehydrate(merged) } as ImportedSavesDoc)
      .catch(console.error);
    // Add all imported IDs to savedIds
    const existingSaved = new Set(prefsRef.current.savedIds);
    const newIds = parsed.map(a => a.id).filter(id => !existingSaved.has(id));
    if (newIds.length) {
      updatePrefs({ ...prefsRef.current, savedIds: [...prefsRef.current.savedIds, ...newIds] });
    }
    return true;
  }, [database, updatePrefs]);

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

  // Auto-fetch on startup only when there is no cached feed to show.
  // After that, all refreshes are explicit (refresh button or pull-to-refresh).
  useEffect(() => {
    if (!prefsReady) return;
    if (lastRefresh) return; // cache loaded — wait for user to refresh manually
    refresh(prefsRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefsReady]); // one-shot: only runs once when prefs become ready

  const savedIds  = new Set(prefs.savedIds);
  const poolIds   = new Set(articlePool.map(a => a.id));
  const savedArticles = [
    ...articlePool.filter(a => savedIds.has(a.id)),
    // Imported bookmark articles not already in the RSS pool
    ...importedSaves.filter(a => savedIds.has(a.id) && !poolIds.has(a.id)),
  ];

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
    onExportBookmarks:    handleExportBookmarks,
    onImportBookmarks:    handleImportBookmarks,
    feedEnterIds,
  };
}
