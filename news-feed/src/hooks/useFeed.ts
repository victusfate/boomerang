import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { kvGet, kvSet } from '../services/kvStore';
import { fetchAllSources, DEFAULT_SOURCES } from '../services/newsService';
import { rankFeed } from '../services/algorithm';
import {
  DEFAULT_PREFS,
  markRead, markSeen, toggleSaved,
  boostTopic, toggleSource, toggleTopic, isSourceEnabled,
  upvote, downvote, applyDecay, resetLearnedWeights, clearViewedCache,
  addCustomSource, removeCustomSource, exportOPML, importOPML,
  exportBookmarkHTML, importBookmarkHTML,
  addUserLabel, deleteUserLabel, renameUserLabel,
} from '../services/storage';
import { getPromptApiAvailability, isPromptApiAvailable, runTaggingPass } from '../services/labelClassifier';
import {
  dehydrate,
  hydrate,
  mergeArticleTags,
  mergeLabelHits,
  mergePrefs,
  parseSyncHash,
  SYNC_LOG,
  type StoredArticle,
} from '../services/syncShare';
import { mergeSavedArticleSnapshots, SYNC_PLACEHOLDER_SOURCE_ID } from '../services/syncWorker';
import type { Article, ArticleTag, CustomSource, LabelHit, Topic, UserLabel, UserPrefs } from '../types';

const PAGE_SIZE          = 5;
const PREFS_ID           = 'user-prefs';
const CACHE_ID           = 'feed-cache';
const IMPORTED_SAVES_ID  = 'imported-saves';
const CLASSIFICATIONS_ID = 'ai-classifications';
const ARTICLE_TAGS_ID    = 'ai-article-tags';
interface FeedCacheDoc        { articles: StoredArticle[]; fetchedAt: number }
interface ImportedSavesDoc    { articles: StoredArticle[] }
interface ClassificationsDoc  { hits: LabelHit[] }
interface ArticleTagsDoc      { hits: ArticleTag[] }

function scrubPlaceholderSaves(
  prefs: UserPrefs,
  imported: Article[],
  extraPlaceholderIds: Iterable<string> = [],
): { prefs: UserPrefs; imported: Article[]; removedSavedIds: string[] } {
  const placeholderIds = new Set<string>(extraPlaceholderIds);
  for (const article of imported) {
    if (article.sourceId === SYNC_PLACEHOLDER_SOURCE_ID) {
      placeholderIds.add(article.id);
    }
  }
  if (placeholderIds.size === 0) return { prefs, imported, removedSavedIds: [] };

  const nextImported = imported.filter(a => a.sourceId !== SYNC_PLACEHOLDER_SOURCE_ID);
  const removedSavedIds = prefs.savedIds.filter(id => placeholderIds.has(id));
  if (removedSavedIds.length === 0) return { prefs, imported: nextImported, removedSavedIds: [] };

  const now = Date.now();
  const nextSavedAtById = { ...(prefs.savedAtById ?? {}) };
  const nextUnsavedAtById = { ...(prefs.unsavedAtById ?? {}) };
  for (const id of removedSavedIds) {
    delete nextSavedAtById[id];
    nextUnsavedAtById[id] = Math.max(nextUnsavedAtById[id] ?? 0, now);
  }

  return {
    prefs: {
      ...prefs,
      savedIds: prefs.savedIds.filter(id => !placeholderIds.has(id)),
      savedAtById: nextSavedAtById,
      unsavedAtById: nextUnsavedAtById,
    },
    imported: nextImported,
    removedSavedIds,
  };
}


export interface UseFeedMetaCallbacks {
  feedTaggedArticle: (articleId: string, tags: string[]) => void;
  endTaggingPass: () => void;
}

export interface UseFeedOptions {
  metaCallbacks?: UseFeedMetaCallbacks;
  metaTagsMap?: Map<string, string[]>;
}

export function useFeed(options?: UseFeedOptions) {
  const { metaCallbacks, metaTagsMap } = options ?? {};

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

  const [labelHits, setLabelHits] = useState<LabelHit[]>([]);
  const labelHitsRef = useRef<LabelHit[]>([]);
  labelHitsRef.current = labelHits;

  const [articleTags, setArticleTags] = useState<ArticleTag[]>([]);
  const articleTagsRef = useRef<ArticleTag[]>([]);
  articleTagsRef.current = articleTags;

  const [classificationStatus, setClassificationStatus] = useState('');
  const [aiTaggingStarted, setAiTaggingStarted] = useState(false);
  const [taggingArticleId, setTaggingArticleId] = useState<string | null>(null);
  const aiModelPollTimerRef = useRef<number | null>(null);

  // ── URL hash sync import ──────────────────────────────────────────────────────
  // Runs once on mount — reads #sync=<base64> and merges into Fireproof docs silently.
  const urlImportDone = useRef(false);
  const consumeSyncHash = useCallback(() => {
    if (urlImportDone.current || typeof location === 'undefined') return null;
    urlImportDone.current = true;
    const payload = parseSyncHash();
    if (payload) history.replaceState(null, '', location.pathname + location.search);
    return payload;
  }, []);

  // ── Persist prefs ────────────────────────────────────────────────────────────
  const updatePrefs = useCallback((next: UserPrefs) => {
    setPrefsState(next);
    kvSet(PREFS_ID, next).catch(console.error);
  }, []);

  const stopAiModelPolling = useCallback(() => {
    if (aiModelPollTimerRef.current) {
      window.clearInterval(aiModelPollTimerRef.current);
      aiModelPollTimerRef.current = null;
    }
  }, []);

  const startAiModelPolling = useCallback(() => {
    if (aiModelPollTimerRef.current) return;
    const poll = async () => {
      const availability = await getPromptApiAvailability();
      if (availability === 'available') {
        stopAiModelPolling();
        setClassificationStatus('Chrome AI model ready — starting tagging…');
        if (allArticlesRef.current.length > 0) {
          schedulePassRef.current([...allArticlesRef.current]);
        }
      } else if (availability === 'downloading') {
        setClassificationStatus('Chrome AI model downloading…');
      } else if (availability === 'downloadable') {
        setClassificationStatus('Chrome AI model needs download — use Chrome AI setup');
      } else if (availability === 'unavailable') {
        stopAiModelPolling();
        setClassificationStatus('Chrome AI unavailable (unavailable) — check browser/model support');
      }
    };
    void poll();
    aiModelPollTimerRef.current = window.setInterval(() => { void poll(); }, 5000);
  }, [stopAiModelPolling]);

  // ── Tagging pass (Chrome 138+ Prompt API, no-op elsewhere) ──────────────────
  /** `articles` should be feed **display order** (e.g. `allArticles`): top cards are tagged first. */
  const scheduleTaggingPass = useCallback((articles: Article[]) => {
    if (!isPromptApiAvailable()) {
      console.info('[AI Tags] schedule skipped — LanguageModel not available');
      return;
    }
    const schedule: (cb: () => void) => void =
      typeof requestIdleCallback !== 'undefined'
        ? (cb) => requestIdleCallback(() => cb(), { timeout: 5000 })
        : (cb) => setTimeout(cb, 0);

    schedule(() => {
      void (async () => {
        const idleT0 = typeof performance !== 'undefined' ? performance.now() : Date.now();

        // Tag in feed display order — visible/high-ranked cards first
        const rankMap = new Map(allArticlesRef.current.map((a, i) => [a.id, i]));
        const sortedArticles = [...articles].sort((a, b) => {
          const ra = rankMap.get(a.id) ?? Infinity;
          const rb = rankMap.get(b.id) ?? Infinity;
          return ra - rb;
        });

        console.info('[AI Tags] idle run start', { inputArticles: sortedArticles.length });

        const existing = articleTagsRef.current;
        const toTag = sortedArticles.filter(a => !existing.some(t => t.articleId === a.id));
        if (toTag.length === 0) {
          console.info('[AI Tags] skip — nothing new to tag', {
            inputArticles: sortedArticles.length,
            storedTagRows: existing.length,
          });
          setTaggingArticleId(null);
          setClassificationStatus('');
          return;
        }
        setClassificationStatus(`Preparing on-device model… (${toTag.length} articles)`);
        let done = 0;
        try {
          await runTaggingPass(sortedArticles, existing, (tag) => {
            done++;
            // Per-article logs + timings live in labelClassifier.runTaggingPass
            setClassificationStatus(`Tagging articles… ${done}/${toTag.length}`);
            metaCallbacks?.feedTaggedArticle(tag.articleId, tag.tags);
            setArticleTags(prev => {
              const updated = [...prev, tag];
              articleTagsRef.current = updated;
              kvSet(ARTICLE_TAGS_ID, { hits: updated }).catch(console.error);
              return updated;
            });
          }, {
            onModelStatus: (status) => {
              const copy = {
                checking: 'Checking Chrome AI model…',
                available: 'Starting Chrome AI model…',
                'starting-download': 'Starting Chrome AI model download…',
                downloadable: 'Chrome AI model needs download — use Chrome AI setup',
                downloading: 'Chrome AI model downloading…',
              } satisfies Record<typeof status, string>;
              setClassificationStatus(copy[status]);
              if (status === 'downloadable' || status === 'downloading' || status === 'starting-download') {
                startAiModelPolling();
              }
            },
            onModelDownloadProgress: (loaded) => {
              setClassificationStatus(`Chrome AI model downloading… ${Math.round(loaded * 100)}%`);
            },
            onSessionReady: () => {
              setAiTaggingStarted(true);
              setClassificationStatus(`Tagging articles… 0/${toTag.length}`);
            },
            onArticleStart: (i, total, articleId) => {
              setClassificationStatus(`Tagging article ${i}/${total}…`);
              setTaggingArticleId(articleId ?? null);
            },
            onUnavailable: (availability, reason) => {
              setClassificationStatus(
                reason === 'mobile-user-agent'
                  ? 'Chrome AI unavailable — disable mobile emulation'
                  : `Chrome AI unavailable (${availability ?? 'unknown'}) — check browser/model support`,
              );
            },
          });
        } catch (e) {
          console.error('[AI Tags] pass threw', e);
          const msg = e instanceof Error ? e.message : String(e);
          if (
            msg.includes('service is not running')
            || (typeof DOMException !== 'undefined' && e instanceof DOMException && e.name === 'NotAllowedError')
          ) {
            console.info(
              '[AI Tags] On-device AI may be stopped or still downloading. Check chrome://on-device-internals, flags in https://developer.chrome.com/docs/ai/get-started — first create() may need a recent user gesture.',
            );
          }
          setTaggingArticleId(null);
          setClassificationStatus('');
          return;
        }
        setTaggingArticleId(null);
        metaCallbacks?.endTaggingPass();
        const idleMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - idleT0);
        console.info('[AI Tags] idle run finished', {
          tagged: done,
          expected: toTag.length,
          wallMsFromIdleStart: idleMs,
        });
        if (done > 0) {
          setClassificationStatus(`Tagged — ${done} articles processed`);
        }
      })();
    });
  }, [startAiModelPolling]);

  const schedulePassRef = useRef(scheduleTaggingPass);
  schedulePassRef.current = scheduleTaggingPass;

  const handleStartAiTagging = useCallback(() => {
    if (allArticlesRef.current.length === 0) {
      setClassificationStatus('Load articles before starting Chrome AI tagging');
      return;
    }
    schedulePassRef.current([...allArticlesRef.current]);
  }, []);

  // ── Load prefs + cache from Fireproof on mount ────────────────────────────────
  useEffect(() => {
    const prefsPromise = kvGet<UserPrefs>(PREFS_ID)
      .then(doc => {
        let merged: UserPrefs = { ...DEFAULT_PREFS, ...doc };
        let shouldPersistPrefs = false;
        // One-time migration: old whitelist `enabledSources` → blacklist `disabledSourceIds`
        if ((merged.enabledSources?.length ?? 0) > 0 && (merged.disabledSourceIds?.length ?? 0) === 0) {
          const enabledSet = new Set(merged.enabledSources);
          merged = {
            ...merged,
            disabledSourceIds: DEFAULT_SOURCES.map(s => s.id).filter(id => !enabledSet.has(id)),
            enabledSources: [],
          };
          shouldPersistPrefs = true;
        }
        // One-time migration: ensure all saved ids have a timestamp so cross-device ordering can converge.
        if (merged.savedIds.length > 0) {
          const nextSavedAtById = { ...(merged.savedAtById ?? {}) };
          let addedAny = false;
          const base = Date.now() - merged.savedIds.length;
          merged.savedIds.forEach((id, idx) => {
            if (nextSavedAtById[id] === undefined) {
              nextSavedAtById[id] = base + idx;
              addedAny = true;
            }
          });
          if (addedAny) {
            merged = { ...merged, savedAtById: nextSavedAtById };
            shouldPersistPrefs = true;
          }
        }
        const decayed = applyDecay(merged);
        if (decayed !== merged) shouldPersistPrefs = true;
        setPrefsState(decayed);
        if (shouldPersistPrefs) {
          kvSet(PREFS_ID, decayed).catch(console.error);
        }
        return decayed;
      })
      .catch(() => DEFAULT_PREFS);

    const cachePromise = kvGet<FeedCacheDoc>(CACHE_ID)
      .then(cache => cache?.articles?.length
        ? { articles: hydrate(cache.articles), fetchedAt: cache.fetchedAt }
        : null)
      .catch(() => null);

    const importedSavesPromise = kvGet<ImportedSavesDoc>(IMPORTED_SAVES_ID)
      .then(doc => doc?.articles?.length ? hydrate(doc.articles) : [])
      .catch(() => [] as Article[]);

    const classificationsPromise = kvGet<ClassificationsDoc>(CLASSIFICATIONS_ID)
      .then(doc => doc?.hits ?? [])
      .catch(() => [] as LabelHit[]);

    const articleTagsPromise = kvGet<ArticleTagsDoc>(ARTICLE_TAGS_ID)
      .then(doc => doc?.hits ?? [])
      .catch(() => [] as ArticleTag[]);

    Promise.all([prefsPromise, cachePromise, importedSavesPromise, classificationsPromise, articleTagsPromise]).then(([loadedPrefs, cached, imported, hits, tags]) => {
      const syncPayload = consumeSyncHash();
      console.info(SYNC_LOG, 'startup local docs loaded', {
        hasSyncPayload: Boolean(syncPayload),
        importedSaves: imported.length,
        labelHits: hits.length,
        articleTags: tags.length,
        savedIds: loadedPrefs.savedIds.length,
        userLabels: loadedPrefs.userLabels.length,
      });
      const remotePlaceholderIds = new Set(
        (syncPayload?.savedArticles ?? [])
          .filter(a => a.sourceId === SYNC_PLACEHOLDER_SOURCE_ID)
          .map(a => a.id),
      );
      const syncedPrefs = syncPayload?.prefs
        ? mergePrefs(loadedPrefs, syncPayload.prefs)
        : loadedPrefs;
      const mergedImported = syncPayload?.savedArticles?.length
        ? mergeSavedArticleSnapshots(hydrate(syncPayload.savedArticles), imported)
        : imported;
      const { prefs: cleanedPrefs, imported: syncedImported, removedSavedIds } =
        scrubPlaceholderSaves(syncedPrefs, mergedImported, remotePlaceholderIds);
      const syncedHits = syncPayload?.labelHits?.length
        ? mergeLabelHits(hits, syncPayload.labelHits)
        : hits;
      const syncedTags = syncPayload?.articleTags?.length
        ? mergeArticleTags(tags, syncPayload.articleTags)
        : tags;

      if (syncPayload) {
        console.info(SYNC_LOG, 'merged sync payload', {
          importedSavesBefore: imported.length,
          importedSavesAfter: syncedImported.length,
          labelHitsBefore: hits.length,
          labelHitsAfter: syncedHits.length,
          articleTagsBefore: tags.length,
          articleTagsAfter: syncedTags.length,
          savedIdsBefore: loadedPrefs.savedIds.length,
          savedIdsAfter: cleanedPrefs.savedIds.length,
          placeholdersRemoved: removedSavedIds.length,
          userLabelsBefore: loadedPrefs.userLabels.length,
          userLabelsAfter: cleanedPrefs.userLabels.length,
        });
        kvSet(PREFS_ID, cleanedPrefs)
          .then(() => console.info(SYNC_LOG, 'wrote user-prefs'))
          .catch(e => console.error(SYNC_LOG, 'failed writing user-prefs', e));
        kvSet(IMPORTED_SAVES_ID, { articles: dehydrate(syncedImported) })
          .then(() => console.info(SYNC_LOG, 'wrote imported-saves', { count: syncedImported.length }))
          .catch(e => console.error(SYNC_LOG, 'failed writing imported-saves', e));
        kvSet(CLASSIFICATIONS_ID, { hits: syncedHits })
          .then(() => console.info(SYNC_LOG, 'wrote ai-classifications', { count: syncedHits.length }))
          .catch(e => console.error(SYNC_LOG, 'failed writing ai-classifications', e));
        kvSet(ARTICLE_TAGS_ID, { hits: syncedTags })
          .then(() => console.info(SYNC_LOG, 'wrote ai-article-tags', { count: syncedTags.length }))
          .catch(e => console.error(SYNC_LOG, 'failed writing ai-article-tags', e));
      } else if (removedSavedIds.length > 0) {
        kvSet(PREFS_ID, cleanedPrefs).catch(console.error);
        kvSet(IMPORTED_SAVES_ID, { articles: dehydrate(syncedImported) }).catch(console.error);
      }

      // Merge startup prefs into current React state. `useSyncWorker` may already have applied
      // a poll (`applyRemoteSync`) using prefs from this same DB snapshot — that merge must not
      // be clobbered by a second `setPrefsState` from the snapshot-only `syncedPrefs`.
      setPrefsState(prev => mergePrefs(cleanedPrefs, prev));
      if (syncedImported.length) {
        importedSavesRef.current = syncedImported;
        setImportedSaves(syncedImported);
      }
      if (syncedHits.length) {
        labelHitsRef.current = syncedHits;
        setLabelHits(syncedHits);
      }
      if (syncedTags.length) {
        articleTagsRef.current = syncedTags;
        setArticleTags(syncedTags);
      }
      setPrefsReady(true);

      if (cached?.articles.length) {
        articlePoolRef.current = cached.articles;
        setArticlePool(cached.articles);

        const ranked = rankFeed(cached.articles, mergePrefs(cleanedPrefs, prefsRef.current));
        allArticlesRef.current = ranked;
        setAllArticles(ranked);
        if (ranked.length) setLoading(false);

        // Mark cache as valid so we skip the auto-fetch on startup
        setLastRefresh(new Date(cached.fetchedAt));

        // Without this, `refresh()` never runs on cold start when cache exists — AI tagging
        // (and the status bar) only appeared after a manual refresh. Re-run the same pass as post-fetch.
        queueMicrotask(() => {
          schedulePassRef.current([...ranked]);
        });
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => {
    if (feedEnterClearTimerRef.current) clearTimeout(feedEnterClearTimerRef.current);
    stopAiModelPolling();
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
      setVisibleCount(PAGE_SIZE);   // reset pagination NOW so the sentinel is fresh
      markedSeenRef.current.clear();
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

    const applyRankedBatch = (accumulated: Article[]) => {
      const ranked = rankFeed(accumulated, currentPrefs);
      // Same merge for explicit and background: preserve prior order for ids still present, append new
      // (avoids background tier prepending and matches split-fetch anchor behavior).
      mergeIncrementalAppend(ranked);
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
        }
        fetchingRef.current = false;
      } else {
        fetchingRef.current = false;
      }
    }
  }, []); // stable — does not depend on volatile state

  // ── Mark a single article as seen after the user has dwelt on it ─────────────
  // Called by ArticleCard via IntersectionObserver + dwell timer (see ArticleCard.tsx).
  const handleSeen = useCallback((id: string) => {
    if (markedSeenRef.current.has(id)) return; // already counted this session
    markedSeenRef.current.add(id);
    setPrefsState(prev => {
      const next = markSeen([id], prev);
      kvSet(PREFS_ID, next).catch(console.error);
      return next;
    });
  }, []);

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

  const handleAddLabel = useCallback((label: UserLabel) => {
    const next = addUserLabel(label, prefsRef.current);
    updatePrefs(next);
  }, [updatePrefs]);

  const handleDeleteLabel = useCallback((labelId: string) => {
    updatePrefs(deleteUserLabel(labelId, prefsRef.current));
    setLabelHits(prev => {
      const filtered = prev.filter(h => h.labelId !== labelId);
      labelHitsRef.current = filtered;
      kvSet(CLASSIFICATIONS_ID, { hits: filtered }).catch(console.error);
      return filtered;
    });
  }, [updatePrefs]);

  const handleRenameLabel = useCallback((labelId: string, name: string) => {
    updatePrefs(renameUserLabel(labelId, name, prefsRef.current));
  }, [updatePrefs]);

  const handleAddManualTag = useCallback((articleId: string, raw: string) => {
    const tag = raw.trim().toLowerCase();
    if (!tag) return;
    setArticleTags(prev => {
      const existing = prev.find(t => t.articleId === articleId);
      let updated: ArticleTag[];
      if (existing) {
        if (existing.tags.includes(tag)) return prev;
        updated = prev.map(t =>
          t.articleId === articleId ? { ...t, tags: [...t.tags, tag], taggedAt: Date.now() } : t
        );
      } else {
        updated = [...prev, { articleId, tags: [tag], taggedAt: Date.now() }];
      }
      articleTagsRef.current = updated;
      kvSet(ARTICLE_TAGS_ID, { hits: updated }).catch(console.error);
      return updated;
    });
  }, []);

  const handleRemoveManualTag = useCallback((articleId: string, tag: string) => {
    setArticleTags(prev => {
      const existing = prev.find(t => t.articleId === articleId);
      if (!existing) return prev;
      const newTags = existing.tags.filter(t => t !== tag);
      const updated = newTags.length > 0
        ? prev.map(t => t.articleId === articleId ? { ...t, tags: newTags, taggedAt: Date.now() } : t)
        : prev.filter(t => t.articleId !== articleId);
      articleTagsRef.current = updated;
      kvSet(ARTICLE_TAGS_ID, { hits: updated }).catch(console.error);
      return updated;
    });
  }, []);

  const handleToggleAiBar = useCallback(() => {
    updatePrefs({ ...prefsRef.current, hideAiBar: !prefsRef.current.hideAiBar });
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
    refresh(next, false); // background merge — append new articles (split fetch)
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
    const savedIds = new Set(prefsRef.current.savedIds);
    const savedAtById = prefsRef.current.savedAtById ?? {};
    const savedRank = new Map(prefsRef.current.savedIds.map((id, idx) => [id, idx]));
    const poolIds = new Set(articlePoolRef.current.map(a => a.id));
    const savedById = new Map<string, Article>();
    for (const article of articlePoolRef.current) {
      if (savedIds.has(article.id)) savedById.set(article.id, article);
    }
    for (const article of importedSavesRef.current) {
      if (savedIds.has(article.id) && !poolIds.has(article.id)) savedById.set(article.id, article);
    }
    const allSaved = prefsRef.current.savedIds
      .slice()
      .sort((a, b) => {
        const ta = savedAtById[a] ?? 0;
        const tb = savedAtById[b] ?? 0;
        if (tb !== ta) return tb - ta;
        return (savedRank.get(b) ?? 0) - (savedRank.get(a) ?? 0);
      })
      .map(id => savedById.get(id))
      .filter((article): article is Article => article !== undefined);
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
    kvSet(IMPORTED_SAVES_ID, { articles: dehydrate(merged) }).catch(console.error);
    // Add all imported IDs to savedIds
    const existingSaved = new Set(prefsRef.current.savedIds);
    const newIds = parsed.map(a => a.id).filter(id => !existingSaved.has(id));
    if (newIds.length) {
      const now = Date.now();
      const publishedById = new Map(parsed.map(a => [a.id, a.publishedAt.getTime()]));
      const nextSavedAtById = { ...(prefsRef.current.savedAtById ?? {}) };
      const nextUnsavedAtById = { ...(prefsRef.current.unsavedAtById ?? {}) };
      for (const id of newIds) {
        nextSavedAtById[id] = publishedById.get(id) ?? now;
        delete nextUnsavedAtById[id];
      }
      updatePrefs({
        ...prefsRef.current,
        savedIds: [...prefsRef.current.savedIds, ...newIds],
        savedAtById: nextSavedAtById,
        unsavedAtById: nextUnsavedAtById,
      });
    }
    return true;
  }, [updatePrefs]);

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

  // ── Live remote sync merge (sync-worker poll) ────────────────────────────────
  // Called by useSyncWorker whenever a poll returns merged remote data.
  const applyRemoteSync = useCallback((payload: {
    prefs: UserPrefs;
    articleTags: ArticleTag[];
    labelHits: LabelHit[];
    savedArticles: Article[];
  }) => {
    const remotePlaceholderIds = new Set(
      payload.savedArticles
        .filter(a => a.sourceId === SYNC_PLACEHOLDER_SOURCE_ID)
        .map(a => a.id),
    );
    // Merge prefs (includes savedIds, topic weights, etc.)
    const mergedPrefs = mergePrefs(prefsRef.current, payload.prefs);

    // Merge saved articles into importedSaves — only non-RSS-pool articles are
    // persisted here; pool articles show up via prefs.savedIds automatically.
    const poolIds = new Set(articlePoolRef.current.map(a => a.id));
    const remoteNonPool = payload.savedArticles.filter(a => !poolIds.has(a.id));
    const mergedImported = mergeSavedArticleSnapshots(remoteNonPool, importedSavesRef.current);
    const { prefs: cleanedPrefs, imported: cleanedImported } =
      scrubPlaceholderSaves(mergedPrefs, mergedImported, remotePlaceholderIds);
    updatePrefs(cleanedPrefs);
    importedSavesRef.current = cleanedImported;
    setImportedSaves(cleanedImported);
    kvSet(IMPORTED_SAVES_ID, { articles: dehydrate(cleanedImported) }).catch(console.error);

    // Merge label hits
    const mergedHits = mergeLabelHits(labelHitsRef.current, payload.labelHits);
    if (mergedHits.length !== labelHitsRef.current.length) {
      labelHitsRef.current = mergedHits;
      setLabelHits(mergedHits);
      kvSet(CLASSIFICATIONS_ID, { hits: mergedHits }).catch(console.error);
    }

    // Merge article tags
    const mergedTags = mergeArticleTags(articleTagsRef.current, payload.articleTags);
    if (mergedTags.length !== articleTagsRef.current.length) {
      articleTagsRef.current = mergedTags;
      setArticleTags(mergedTags);
      kvSet(ARTICLE_TAGS_ID, { hits: mergedTags }).catch(console.error);
    }
  }, [updatePrefs]);

  // Auto-fetch on startup only when there is no cached feed to show.
  // After that, all refreshes are explicit (refresh button or pull-to-refresh).
  useEffect(() => {
    if (!prefsReady) return;
    if (lastRefresh) return; // cache loaded — wait for user to refresh manually
    refresh(prefsRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefsReady]); // one-shot: only runs once when prefs become ready

  const savedIds  = new Set(prefs.savedIds);
  const savedAtById = prefs.savedAtById ?? {};
  const savedRank = new Map(prefs.savedIds.map((id, idx) => [id, idx]));
  const poolIds   = new Set(articlePool.map(a => a.id));
  const savedById = new Map<string, Article>();
  for (const article of articlePool) {
    if (savedIds.has(article.id)) savedById.set(article.id, article);
  }
  // Imported bookmark articles not already in the RSS pool
  for (const article of importedSaves) {
    if (savedIds.has(article.id) && !poolIds.has(article.id)) savedById.set(article.id, article);
  }
  const savedArticles = prefs.savedIds
    .slice()
    .sort((a, b) => {
      const ta = savedAtById[a] ?? 0;
      const tb = savedAtById[b] ?? 0;
      if (tb !== ta) return tb - ta;
      return (savedRank.get(b) ?? 0) - (savedRank.get(a) ?? 0);
    })
    .map(id => savedById.get(id))
    .filter((article): article is Article => article !== undefined);

  const articleTagsMap = useMemo(() => {
    const map = new Map<string, string[]>(articleTags.map(t => [t.articleId, t.tags]));
    if (metaTagsMap) {
      for (const [id, metaTags] of metaTagsMap) {
        const local = map.get(id);
        if (local) {
          const merged = [...new Set([...local, ...metaTags])];
          map.set(id, merged);
        } else {
          map.set(id, metaTags);
        }
      }
    }
    return map;
  }, [articleTags, metaTagsMap]);

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
    onToggleAiBar:       handleToggleAiBar,
    onResetPrefs:        handleResetPrefs,
    onClearViewed:       handleClearViewed,
    onRefresh:           handleRefresh,
    onAddCustomSource:    handleAddCustomSource,
    onRemoveCustomSource: handleRemoveCustomSource,
    onExportOPML:         handleExportOPML,
    onImportOPML:         handleImportOPML,
    onExportBookmarks:    handleExportBookmarks,
    onImportBookmarks:    handleImportBookmarks,
    labelHits,
    articleTags,
    articleTagsMap,
    classificationStatus,
    aiTaggingStarted,
    taggingArticleId,
    onStartAiTagging: handleStartAiTagging,
    onAddLabel:    handleAddLabel,
    onDeleteLabel: handleDeleteLabel,
    onRenameLabel: handleRenameLabel,
    onAddManualTag:    handleAddManualTag,
    onRemoveManualTag: handleRemoveManualTag,
    feedEnterIds,
    onRemoteSync: applyRemoteSync,
    syncReady: prefsReady,
  };
}
