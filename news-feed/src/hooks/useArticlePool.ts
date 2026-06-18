import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { kvSet } from '../services/kvStore';
import { fetchAllSources, DEFAULT_SOURCES } from '../services/newsService';
import { rankFeed } from '../services/algorithm';
import { isSourceEnabled } from '../services/storage';
import { dehydrate } from '../services/syncShare';
import type { Article, UserPrefs } from '../types';
import type { RecInteractionInput } from '../services/recWorker';

export const PAGE_SIZE = 5;
export const CACHE_ID  = 'feed-cache';
const ENTER_ANIM_DURATION_MS = 550;

export interface UseArticlePoolParams {
  prefsRef: MutableRefObject<UserPrefs>;
  schedulePassRef: MutableRefObject<(articles: Article[]) => void>;
  recInteract?: (input: RecInteractionInput) => void;
  recArticleIds?: string[];
  recStatus?: 'disabled' | 'active' | 'error';
  recBootstrapDone?: boolean;
  recBootstrapError?: string | null;
  recCandidateMode?: 'feed-pool' | 'global';
  onArticlePoolIds?: (ids: string[]) => void;
}

export interface UseArticlePoolResult {
  allArticles: Article[];
  articlePool: Article[];
  visibleCount: number;
  loading: boolean;
  refreshing: boolean;
  fetching: boolean;
  error: string | null;
  lastRefresh: Date | null;
  feedEnterIds: string[];
  articlePoolRef: MutableRefObject<Article[]>;
  allArticlesRef: MutableRefObject<Article[]>;
  markedSeenRef: MutableRefObject<Set<string>>;
  recInteractRef: MutableRefObject<((input: RecInteractionInput) => void) | undefined>;
  fetchIdRef: MutableRefObject<number>;
  fetchingRef: MutableRefObject<boolean>;
  getRankRecIds: () => string[];
  refresh: (currentPrefs: UserPrefs, explicit?: boolean) => Promise<void>;
  loadMore: () => void;
  initPool: (cached: { articles: Article[]; fetchedAt: number } | null, prefs: UserPrefs) => void;
  setAllArticles: React.Dispatch<React.SetStateAction<Article[]>>;
  setVisibleCount: React.Dispatch<React.SetStateAction<number>>;
}

export function useArticlePool(params: UseArticlePoolParams): UseArticlePoolResult {
  const {
    prefsRef, schedulePassRef,
    recInteract, recArticleIds, recStatus, recBootstrapDone, recBootstrapError,
    recCandidateMode, onArticlePoolIds,
  } = params;

  const [allArticles, setAllArticles] = useState<Article[]>([]);
  const [articlePool, setArticlePool] = useState<Article[]>([]);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing]  = useState(false);
  const [fetching, setFetching]     = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [feedEnterIds, setFeedEnterIds] = useState<string[]>([]);

  const articlePoolRef   = useRef<Article[]>([]);
  articlePoolRef.current = articlePool;
  const allArticlesRef   = useRef<Article[]>([]);
  allArticlesRef.current = allArticles;
  const markedSeenRef    = useRef(new Set<string>());
  const feedShownRef     = useRef(false);
  const fetchIdRef       = useRef(0);
  const fetchingRef      = useRef(false);
  const feedEnterClearTimerRef = useRef<number | null>(null);

  // ── Rec policy refs ────────────────────────────────────────────────────────────
  const recInteractRef         = useRef<((input: RecInteractionInput) => void) | undefined>(undefined);
  const recArticleIdsRef       = useRef<string[]>([]);
  const recStatusRef           = useRef<'disabled' | 'active' | 'error'>('disabled');
  const recBootstrapDoneRef    = useRef(false);
  const recBootstrapErrorRef   = useRef<string | null>(null);
  const recCandidateModeRef    = useRef<'feed-pool' | 'global' | undefined>(undefined);
  // Locked once: either server recommendations (ids) or local fallback (null).
  const selectedRecRankIdsRef  = useRef<string[] | null | undefined>(undefined);

  useEffect(() => {
    recInteractRef.current = recInteract;
    recArticleIdsRef.current = recArticleIds ?? [];
    recStatusRef.current = recStatus ?? 'disabled';
    recBootstrapDoneRef.current = recBootstrapDone ?? false;
    recBootstrapErrorRef.current = recBootstrapError ?? null;
    recCandidateModeRef.current = recCandidateMode;
  });

  const getRankRecIds = useCallback((): string[] => {
    if (selectedRecRankIdsRef.current === undefined) return recArticleIdsRef.current;
    return selectedRecRankIdsRef.current ?? [];
  }, []);

  // Publish rec candidates only when the pool snapshot is stable (cache / fetch done).
  const publishRecCandidateIds = useCallback((pool: Article[]) => {
    if (pool.length === 0) { onArticlePoolIds?.([]); return; }
    const ids = rankFeed(pool, prefsRef.current, []).map(a => a.id);
    onArticlePoolIds?.(ids);
  }, [onArticlePoolIds, prefsRef]);
  const publishRecCandidateIdsRef = useRef(publishRecCandidateIds);
  publishRecCandidateIdsRef.current = publishRecCandidateIds;

  // ── Rec bootstrap lock ─────────────────────────────────────────────────────────
  // Lock recommendation policy on bootstrap. Subsequent feed-pool rec refreshes update
  // the stored IDs for the next explicit refresh but do NOT re-rank the live feed.
  useEffect(() => {
    if (!recBootstrapDoneRef.current) return;
    const pool = articlePoolRef.current;
    if (pool.length === 0) return;

    const ids = recArticleIdsRef.current;
    const isFeedPool = recCandidateModeRef.current === 'feed-pool';
    const firstLock = selectedRecRankIdsRef.current === undefined;

    if (firstLock) {
      if (ids.length > 0) {
        selectedRecRankIdsRef.current = [...ids];
        console.info(`[rec] Applied server recommendations for initial ordering (${ids.length} ids).`);
      } else {
        selectedRecRankIdsRef.current = null;
        if (recStatusRef.current === 'error' || recBootstrapErrorRef.current) {
          console.warn('[rec] Recommendation backend unavailable; using local ranking fallback.');
        } else if (recStatusRef.current === 'disabled') {
          console.warn('[rec] Recommendations disabled (missing VITE_PLATFORM_WORKER_URL); using local ranking fallback.');
        } else {
          console.info('[rec] Recommendation backend returned no ids; using local ranking fallback.');
        }
      }
    } else if (isFeedPool && ids.length > 0) {
      selectedRecRankIdsRef.current = [...ids];
      return;
    } else {
      return;
    }

    if (feedShownRef.current) return;

    const ranked = rankFeed(pool, prefsRef.current, getRankRecIds());
    allArticlesRef.current = ranked;
    setAllArticles(ranked);
  }, [recBootstrapDone, recBootstrapError, recStatus, recArticleIds, recCandidateMode, getRankRecIds, prefsRef]);

  useEffect(() => () => {
    if (feedEnterClearTimerRef.current) clearTimeout(feedEnterClearTimerRef.current);
  }, []);

  // ── Network refresh ───────────────────────────────────────────────────────────
  const refresh = useCallback(async (currentPrefs: UserPrefs, explicit = false) => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;

    const myFetchId = ++fetchIdRef.current;

    const hadArticles = allArticlesRef.current.length > 0;
    if (explicit) {
      allArticlesRef.current = [];
      setAllArticles([]);
      setLoading(true);
      setVisibleCount(PAGE_SIZE);
      markedSeenRef.current.clear();
      feedShownRef.current = false;
    } else if (hadArticles) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setFetching(true);
    setError(null);

    const activeSources       = DEFAULT_SOURCES.filter(s => isSourceEnabled(s.id, currentPrefs));
    const activeCustomSources = (currentPrefs.customSources ?? []).filter(s => isSourceEnabled(s.id, currentPrefs));

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
        }, ENTER_ANIM_DURATION_MS);
      }
    };

    const applyRankedBatch = (accumulated: Article[]) => {
      const ranked = rankFeed(accumulated, currentPrefs, getRankRecIds());
      mergeIncrementalAppend(ranked);
    };

    const onBatch = (accumulated: Article[]) => {
      if (fetchIdRef.current !== myFetchId) return;
      const apply = () => {
        if (fetchIdRef.current !== myFetchId) return;
        articlePoolRef.current = accumulated;
        setArticlePool(accumulated);
        if (explicit || !feedShownRef.current) {
          applyRankedBatch(accumulated);
          feedShownRef.current = true;
        }
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
      if (fetchIdRef.current !== myFetchId) return;

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
        if (explicit || !feedShownRef.current) {
          applyRankedBatch(all);
          feedShownRef.current = true;
        }
        kvSet(CACHE_ID, { articles: dehydrate(all), fetchedAt: Date.now() }).catch(console.error);
        schedulePassRef.current([...allArticlesRef.current]);
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
          publishRecCandidateIdsRef.current(articlePoolRef.current);
        }
        fetchingRef.current = false;
      }
    }
  }, [getRankRecIds, schedulePassRef]); // stable — all volatile values read via refs

  const loadMore = useCallback(() => {
    setVisibleCount(prev => {
      const total = allArticlesRef.current.length;
      if (prev >= total) return prev;
      return Math.min(prev + PAGE_SIZE, total);
    });
  }, []);

  // Called by useFeed's mount effect after all kv docs are loaded.
  const initPool = useCallback((
    cached: { articles: Article[]; fetchedAt: number } | null,
    prefs: UserPrefs,
  ) => {
    if (!cached?.articles.length) return;
    articlePoolRef.current = cached.articles;
    setArticlePool(cached.articles);
    publishRecCandidateIdsRef.current(cached.articles);

    const ranked = rankFeed(cached.articles, prefs, getRankRecIds());
    allArticlesRef.current = ranked;
    setAllArticles(ranked);
    if (ranked.length) {
      feedShownRef.current = true;
      setLoading(false);
      setLastRefresh(new Date(cached.fetchedAt));
    }
    queueMicrotask(() => schedulePassRef.current([...ranked]));
  }, [getRankRecIds, schedulePassRef]);

  return {
    allArticles, articlePool, visibleCount, loading, refreshing, fetching, error, lastRefresh, feedEnterIds,
    articlePoolRef, allArticlesRef, markedSeenRef, recInteractRef,
    fetchIdRef, fetchingRef,
    getRankRecIds, refresh, loadMore, initPool,
    setAllArticles, setVisibleCount,
  };
}
