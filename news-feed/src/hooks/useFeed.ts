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
  addUserLabel, deleteUserLabel, renameUserLabel,
} from '../services/storage';
import { isPromptApiAvailable, runTaggingPass } from '../services/labelClassifier';
import type { Article, ArticleTag, CustomSource, LabelHit, Topic, UserLabel, UserPrefs } from '../types';

const PAGE_SIZE          = 5;
const PREFS_ID           = 'user-prefs';
const CACHE_ID           = 'feed-cache';
const IMPORTED_SAVES_ID  = 'imported-saves';
const CLASSIFICATIONS_ID = 'ai-classifications';
const ARTICLE_TAGS_ID    = 'ai-article-tags';

type StoredArticle = Omit<Article, 'publishedAt'> & { publishedAt: string };
interface FeedCacheDoc        { _id: string; articles: StoredArticle[]; fetchedAt: number }
interface ImportedSavesDoc    { _id: string; articles: StoredArticle[] }
interface ClassificationsDoc  { _id: string; hits: LabelHit[] }
interface ArticleTagsDoc      { _id: string; hits: ArticleTag[] }
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

  const [labelHits, setLabelHits] = useState<LabelHit[]>([]);
  const labelHitsRef = useRef<LabelHit[]>([]);
  labelHitsRef.current = labelHits;

  const [articleTags, setArticleTags] = useState<ArticleTag[]>([]);
  const articleTagsRef = useRef<ArticleTag[]>([]);
  articleTagsRef.current = articleTags;

  const [classificationStatus, setClassificationStatus] = useState('');

  // ── URL hash label import ─────────────────────────────────────────────────────
  // Runs once on mount — reads #labels=<base64> and merges into prefs silently.
  const urlImportDone = useRef(false);
  const processUrlHashLabels = useCallback((prefs: UserPrefs) => {
    if (urlImportDone.current || typeof location === 'undefined') return prefs;
    urlImportDone.current = true;
    const hash = location.hash;
    if (!hash.startsWith('#labels=')) return prefs;
    try {
      const encoded = hash.slice('#labels='.length);
      const json = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
      const imported = JSON.parse(json) as UserLabel[];
      if (!Array.isArray(imported)) return prefs;
      const existing = new Set(prefs.userLabels.map(l => l.id));
      const newLabels = imported.filter(l => !existing.has(l.id) && l.id && l.name && l.color);
      if (newLabels.length === 0) return prefs;
      history.replaceState(null, '', location.pathname + location.search);
      return { ...prefs, userLabels: [...prefs.userLabels, ...newLabels] };
    } catch {
      return prefs;
    }
  }, []);

  // ── Persist prefs ────────────────────────────────────────────────────────────
  const updatePrefs = useCallback((next: UserPrefs) => {
    setPrefsState(next);
    database.put({ _id: PREFS_ID, ...next } as PrefsDoc).catch(console.error);
  }, [database]);

  // ── Tagging pass (Chrome 138+ Prompt API, no-op elsewhere) ──────────────────
  const scheduleTaggingPass = useCallback((articles: Article[]) => {
    if (!isPromptApiAvailable()) return;
    const schedule: (cb: () => void) => void =
      typeof requestIdleCallback !== 'undefined'
        ? (cb) => requestIdleCallback(() => cb(), { timeout: 5000 })
        : (cb) => setTimeout(cb, 0);

    schedule(() => {
      void (async () => {
        const existing = articleTagsRef.current;
        const toTag = articles.filter(a => !existing.some(t => t.articleId === a.id));
        if (toTag.length === 0) { setClassificationStatus(''); return; }
        console.log(`[AI Tags] tagging ${toTag.length} new articles…`);
        setClassificationStatus(`Tagging ${toTag.length} articles…`);
        let done = 0;
        await runTaggingPass(articles, existing, (tag) => {
          done++;
          console.log(`[AI Tags] ${tag.articleId}: [${tag.tags.join(', ')}] (${done}/${toTag.length})`);
          setClassificationStatus(`Tagging articles… ${done}/${toTag.length}`);
          setArticleTags(prev => {
            const updated = [...prev, tag];
            articleTagsRef.current = updated;
            database.put({ _id: ARTICLE_TAGS_ID, hits: updated } as ArticleTagsDoc)
              .catch(console.error);
            return updated;
          });
        });
        setClassificationStatus(`Tagged — ${done} articles processed`);
        setTimeout(() => setClassificationStatus(''), 5000);
      })();
    });
  }, [database]);

  const schedulePassRef = useRef(scheduleTaggingPass);
  schedulePassRef.current = scheduleTaggingPass;

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
        const withUrlLabels = processUrlHashLabels(merged);
        const decayed = applyDecay(withUrlLabels);
        setPrefsState(decayed);
        if (decayed !== withUrlLabels || withUrlLabels !== merged) {
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

    const classificationsPromise = database.get<ClassificationsDoc>(CLASSIFICATIONS_ID)
      .then(doc => doc.hits ?? [])
      .catch(() => [] as LabelHit[]);

    const articleTagsPromise = database.get<ArticleTagsDoc>(ARTICLE_TAGS_ID)
      .then(doc => doc.hits ?? [])
      .catch(() => [] as ArticleTag[]);

    Promise.all([prefsPromise, cachePromise, importedSavesPromise, classificationsPromise, articleTagsPromise]).then(([loadedPrefs, cached, imported, hits, tags]) => {
      if (imported.length) {
        importedSavesRef.current = imported;
        setImportedSaves(imported);
      }
      if (hits.length) {
        labelHitsRef.current = hits;
        setLabelHits(hits);
      }
      if (tags.length) {
        articleTagsRef.current = tags;
        setArticleTags(tags);
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
        database.put({ _id: CACHE_ID, articles: dehydrate(all), fetchedAt: Date.now() })
          .catch(console.error);
        schedulePassRef.current(all);
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

  const handleAddLabel = useCallback((label: UserLabel) => {
    const next = addUserLabel(label, prefsRef.current);
    updatePrefs(next);
  }, [updatePrefs]);

  const handleDeleteLabel = useCallback((labelId: string) => {
    updatePrefs(deleteUserLabel(labelId, prefsRef.current));
    setLabelHits(prev => {
      const filtered = prev.filter(h => h.labelId !== labelId);
      labelHitsRef.current = filtered;
      database.put({ _id: CLASSIFICATIONS_ID, hits: filtered } as ClassificationsDoc)
        .catch(console.error);
      return filtered;
    });
  }, [database, updatePrefs]);

  const handleRenameLabel = useCallback((labelId: string, name: string) => {
    updatePrefs(renameUserLabel(labelId, name, prefsRef.current));
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

  function buildLabelsShareUrl(labels: UserLabel[]): string {
    if (labels.length === 0 || typeof location === 'undefined') return '';
    const json = JSON.stringify(labels);
    const b64 = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    return `${location.origin}${location.pathname}#labels=${b64}`;
  }

  const savedIds  = new Set(prefs.savedIds);
  const poolIds   = new Set(articlePool.map(a => a.id));
  const savedArticles = [
    ...articlePool.filter(a => savedIds.has(a.id)),
    // Imported bookmark articles not already in the RSS pool
    ...importedSaves.filter(a => savedIds.has(a.id) && !poolIds.has(a.id)),
  ];

  const articleTagsMap = new Map(articleTags.map(t => [t.articleId, t.tags]));

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
    labelHits,
    articleTags,
    articleTagsMap,
    classificationStatus,
    onAddLabel:    handleAddLabel,
    onDeleteLabel: handleDeleteLabel,
    onRenameLabel: handleRenameLabel,
    labelsShareUrl: buildLabelsShareUrl(prefs.userLabels ?? []),
    feedEnterIds,
  };
}
