import { useState, useMemo, useEffect, useCallback, Fragment } from 'react';
import { useFeed } from './hooks/useFeed';
import { useSyncWorker, type SyncStatus } from './hooks/useSyncWorker';
import { useMetaWorker } from './hooks/useMetaWorker';
import { useRecWorker } from './hooks/useRecWorker';
import { useRecHistoryReplay } from './hooks/useRecHistoryReplay';
import { useOGImageBatch } from './hooks/useOGImageBatch';
import { useHistoryBackfill } from './hooks/useHistoryBackfill';
import { usePullToRefresh } from './hooks/usePullToRefresh';
import { useInfiniteScrollSentinel } from './hooks/useInfiniteScrollSentinel';
import { useVisibilitySync } from './hooks/useVisibilitySync';
import { useTitleCache } from './hooks/useTitleCache';
import { useSourceNameLookup } from './hooks/useSourceNameLookup';
import { SearchOverlay } from './components/SearchOverlay';
import { ArticleCard } from './components/ArticleCard';
import { syncIndicatorState, RefreshIcon, type SyncIndicatorState } from './components/AppHeader';
import { TopicFilter } from './components/TopicFilter';
import { Settings } from './components/Settings';
import { RecDiagnostics } from './components/RecDiagnostics';
import { suggestLabels } from './services/labelSuggester';
import { isPromptApiAvailable } from './services/labelClassifier';
import { sameIdsInOrder } from './services/metaSyncTrigger';
import {
  buildRecRankMap,
  computeFeedScoreInsight,
  countSourceArticles,
} from './services/feedScoreBreakdown';
import type { ActiveFilter, FeedView } from './types';
import { PLATFORM_WORKER_URL } from './config/workerEnv';
import { timeAgo } from './services/timeAgo';

const SKELETON_CARD_COUNT = 5;
const OG_BATCH_SIZE = 10;

/** Word-boundary label↔tag match — bare substring made "AI" match "rain". */
function labelMatchesTag(label: string, tag: string): boolean {
  if (label === tag) return true;
  const asWord = (needle: string) =>
    new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  return asWord(label).test(tag) || asWord(tag).test(label);
}

export default function App() {
  // Meta hook runs first: useFeed needs its callbacks + live tag map from the worker.
  const [articleIds, setArticleIds] = useState<string[]>([]);
  const {
    metaTagsMap, feedTaggedArticle, endTaggingPass, forceMetaSync, metaStatus, metaError, metaEnvError, metaSyncCooldownMs,
  } = useMetaWorker(articleIds);

  const [articlePoolIds, setArticlePoolIds] = useState<string[]>([]);

  const {
    sendInteraction,
    setTopicWeights,
    recArticleIds,
    recScoreById,
    recScoredArticles,
    recModelDiagnostics,
    recGeneratedAt,
    recStatus,
    recBootstrapDone,
    recBootstrapError,
    recUserId,
    recEnvError,
    recTrace,
    recCacheInfo,
    recTimingMs,
  } = useRecWorker(articlePoolIds);

  const {
    allArticles,
    visibleArticles, savedArticles, hasMore, totalLoaded,
    loading, refreshing, fetching, error, prefs, lastRefresh, feedEnterIds,
    onOpen, onSave, onSaveExternal, onClearQueue, onUpvote, onDownvote, onSeen, onLoadMore,
    onToggleSource, onToggleTopic, onResetPrefs, onClearViewed, onRefresh,
    onAddCustomSource, onRemoveCustomSource, onExportOPML, onImportOPML,
    onExportBookmarks, onImportBookmarks,
    articleTagsMap, classificationStatus, aiTaggingStarted, aiAllTagged, taggingArticleId, onStartAiTagging, onAddLabel, onDeleteLabel,
    labelHits, articleTags, onToggleAiBar, onToggleTheme, onAddManualTag, onRemoveManualTag,
    onRemoteSync, syncReady,
  } = useFeed({
    metaCallbacks: { feedTaggedArticle, endTaggingPass },
    metaTagsMap,
    recInteract: sendInteraction,
    recArticleIds,
    recStatus,
    recBootstrapDone,
    recBootstrapError,
    recCandidateMode: recModelDiagnostics?.candidateMode,
    onArticlePoolIds: setArticlePoolIds,
  });

  useRecHistoryReplay(prefs, allArticles, savedArticles, recUserId, recBootstrapDone);

  const { syncActive, syncStatus, syncedAt, syncError, syncErrorDetails, syncUrl, syncEnvError, syncCooldownMs, forceSync, generateLink, revoke } =
    useSyncWorker(prefs, articleTags, labelHits, savedArticles, onRemoteSync, syncReady);

  useEffect(() => {
    document.documentElement.dataset.theme = prefs.theme ?? 'dark';
  }, [prefs.theme]);

  useEffect(() => {
    setTopicWeights(prefs.topicWeights);
  }, [prefs.topicWeights, setTopicWeights]);

  const { getArticleTitle } = useTitleCache(allArticles, savedArticles);
  const { getSourceName } = useSourceNameLookup(allArticles, savedArticles);

  const [view, setView] = useState<FeedView>('feed');
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>(null);
  const [initialQueueCount, setInitialQueueCount] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const { backfilled } = useHistoryBackfill(prefs, PLATFORM_WORKER_URL, syncReady);
  const canUseBrowserAi = isPromptApiAvailable();
  const combinedSyncCooldownMs = Math.max(syncCooldownMs, metaSyncCooldownMs);
  const syncIndicator = syncIndicatorState(
    syncActive,
    syncStatus,
    metaStatus,
    syncedAt,
    syncError,
    syncEnvError,
    combinedSyncCooldownMs,
  );
  const onMainSyncClick = useCallback(() => {
    if (syncReady) {
      void forceSync();
    }
    void forceMetaSync();
  }, [forceMetaSync, forceSync, syncReady]);
  const onManualRefresh = useCallback(() => {
    onRefresh();
    void forceMetaSync();
    if (syncReady) {
      void forceSync();
    }
  }, [onRefresh, forceMetaSync, forceSync, syncReady]);
  const { pullIndicatorRef } = usePullToRefresh(onManualRefresh, showSettings || showSearch);

  useEffect(() => {
    if (view === 'saved') setInitialQueueCount(savedArticles.length);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]); // intentionally snapshot on tab-enter only

  // Starring new articles while on the Queue tab grows the queue past the
  // snapshot — bump the snapshot so progress never reads negative.
  useEffect(() => {
    if (view === 'saved' && savedArticles.length > initialQueueCount) {
      setInitialQueueCount(savedArticles.length);
    }
  }, [view, savedArticles.length, initialQueueCount]);

  // Drive metadata sync target ids in useMetaWorker. `visibleArticles` is a fresh array every
  // render (useFeed does `allArticles.slice(0, visibleCount)`), so comparing by value and
  // returning `prev` avoids setState → render → setState loops.
  useEffect(() => {
    const nextIds = visibleArticles.map(a => a.id);
    setArticleIds(prev => (sameIdsInOrder(prev, nextIds) ? prev : nextIds));
  }, [visibleArticles]);

  // Pull shared metadata for visible cards even when sync-worker is not enabled.
  useEffect(() => {
    if (articleIds.length === 0) return;
    void forceMetaSync();
  }, [articleIds, forceMetaSync]);

  useVisibilitySync(forceMetaSync, forceSync, syncActive, syncReady);

  const { sentinelRef } = useInfiniteScrollSentinel(onLoadMore, view, totalLoaded, hasMore);


  const filteredArticles = useMemo(() => {
    let list = view === 'saved' ? savedArticles : visibleArticles;
    if (activeFilter?.kind === 'topic') list = list.filter(a => a.topics.includes(activeFilter.value));
    if (activeFilter?.kind === 'label') {
      const labelName = (prefs.userLabels ?? []).find(l => l.id === activeFilter.value)?.name?.toLowerCase() ?? '';
      if (!labelName) return [];
      list = list.filter(a => (articleTagsMap.get(a.id) ?? []).some((t: string) => labelMatchesTag(labelName, t)));
    }
    return list;
  }, [visibleArticles, savedArticles, view, activeFilter, articleTagsMap, prefs.userLabels]);

  const showFeedScores = view === 'feed' && recStatus !== 'disabled' && !recEnvError;
  const recRankMap = useMemo(() => buildRecRankMap(recArticleIds), [recArticleIds]);
  const feedSourceCounts = useMemo(() => countSourceArticles(allArticles), [allArticles]);
  const feedScoresLoading = showFeedScores && !recBootstrapDone;
  // Precomputed per-card insight — inline computation ran for every card on
  // every App render, including renders unrelated to ranking.
  const feedScoreInsightById = useMemo(() => {
    if (!showFeedScores) return null;
    const m = new Map<string, ReturnType<typeof computeFeedScoreInsight>>();
    for (const a of filteredArticles) {
      m.set(a.id, computeFeedScoreInsight(a, feedSourceCounts, recRankMap, recScoreById));
    }
    return m;
  }, [showFeedScores, filteredArticles, feedSourceCounts, recRankMap, recScoreById]);

  // When a topic filter is active and the visible slice has no matches yet,
  // automatically load more so the user isn't stuck on a false empty state.
  useEffect(() => {
    if (activeFilter?.kind !== 'topic' || view !== 'feed') return;
    if (fetching || loading || !hasMore) return;
    if (filteredArticles.length === 0) onLoadMore();
  }, [activeFilter, view, fetching, loading, hasMore, filteredArticles.length, onLoadMore]);

  const { ogMap, sentinelRef: ogSentinelRef, fetchedUpTo: ogFetchedUpTo } =
    useOGImageBatch(filteredArticles, OG_BATCH_SIZE);

  const syncBusy = combinedSyncCooldownMs > 0 || syncIndicator.state === 'syncing';
  const ogSentinelIndex = Math.min(ogFetchedUpTo, filteredArticles.length) - 1;

  return (
    <>
      <header className="app-header">
        <div className="header-left">
          <h1 className="app-title">News</h1>
          {lastRefresh && (
            <span className="last-refresh">
              {refreshing ? 'Refreshing…' : timeAgo(lastRefresh, 'ago')}
            </span>
          )}
        </div>
        <div className="header-right">
          <button
            type="button"
            className={`sync-indicator ${syncIndicator.state}`}
            onClick={onMainSyncClick}
            disabled={syncBusy}
            title={syncIndicator.title}
            aria-label="Sync now"
          >
            <span className="sync-indicator-dot" aria-hidden="true" />
            <span>{syncIndicator.label}</span>
          </button>
          <button
            className="icon-btn"
            onClick={() => setShowSearch(true)}
            aria-label="Search"
            title="Search"
          >
            🔍
          </button>
          <button
            className="icon-btn"
            onClick={onManualRefresh}
            disabled={loading}
            aria-label="Refresh feed"
            title="Refresh"
          >
            <RefreshIcon spinning={loading} />
          </button>
          <button
            className="icon-btn"
            onClick={onToggleTheme}
            aria-label={prefs.theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
            title={prefs.theme === 'light' ? 'Dark mode' : 'Light mode'}
          >
            {prefs.theme === 'light' ? '🌙' : '☀️'}
          </button>
          <button
            className="icon-btn"
            onClick={() => setShowSettings(true)}
            aria-label="Settings"
            title="Settings"
          >
            ⚙
          </button>
        </div>
      </header>

      <nav className="view-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={view === 'feed'}
          className={`tab ${view === 'feed' ? 'active' : ''}`}
          onClick={() => setView('feed')}
        >
          Feed
          {totalLoaded > 0 && !loading && (
            <span className="tab-count">{totalLoaded}</span>
          )}
        </button>
        <button
          role="tab"
          aria-selected={view === 'saved'}
          className={`tab ${view === 'saved' ? 'active' : ''}`}
          onClick={() => setView('saved')}
        >
          Queue {savedArticles.length > 0 && <span className="tab-count">{savedArticles.length}</span>}
        </button>
        <button
          role="tab"
          aria-selected={view === 'rec'}
          className={`tab ${view === 'rec' ? 'active' : ''}`}
          onClick={() => setView('rec')}
        >
          Ranking
        </button>
      </nav>

      {view === 'feed' && (
        <TopicFilter
          prefs={prefs}
          userLabels={prefs.userLabels ?? []}
          activeFilter={activeFilter}
          onFilter={setActiveFilter}
        />
      )}

      {view === 'saved' && savedArticles.length > 0 && (
        <div className="queue-header">
          {initialQueueCount > 0 && (
            <span className="queue-progress">
              {initialQueueCount - savedArticles.length} of {initialQueueCount} read
            </span>
          )}
          <button className="btn-clear-queue" onClick={onClearQueue}>
            Clear all
          </button>
        </div>
      )}

      {!prefs.hideAiBar && (
        <div className="ai-status" aria-live="polite">
          <span className={`ai-status-dot ${classificationStatus ? '' : 'idle'}`} />
          {classificationStatus || (aiAllTagged ? 'All articles tagged' : 'Chrome AI tagging')}
          <a
            href="https://developer.chrome.com/docs/ai/get-started"
            target="_blank"
            rel="noreferrer"
          >
            Chrome AI setup
          </a>
          {canUseBrowserAi && !aiTaggingStarted && (
            <button type="button" onClick={onStartAiTagging}>
              Enhance news with browser AI
            </button>
          )}
          <button
            type="button"
            className="ai-status-dismiss"
            onClick={onToggleAiBar}
            aria-label="Hide Chrome AI bar"
            title="Hide"
          >
            ×
          </button>
        </div>
      )}

      <div className="pull-indicator" ref={pullIndicatorRef} style={{ display: 'none' }}>
        <div className="pull-indicator-inner">
          <RefreshIcon spinning={false} />
        </div>
      </div>

      <main className={view === 'rec' ? 'rec-view' : 'feed'}>
        {view === 'rec' ? (
          <RecDiagnostics
            recUserId={recUserId}
            recArticleIds={recArticleIds}
            recScoreById={recScoreById}
            recScoredArticles={recScoredArticles}
            recModelDiagnostics={recModelDiagnostics}
            recTrace={recTrace}
            recCacheInfo={recCacheInfo}
            recTimingMs={recTimingMs}
            recGeneratedAt={recGeneratedAt}
            recStatus={recStatus}
            getSourceName={getSourceName}
            getArticleTitle={getArticleTitle}
          />
        ) : (
          <>
            {(error || metaEnvError || metaError) && (
              <div className="feed-error">
                {error && (
                  <>
                    <p>{error}</p>
                    <button onClick={onManualRefresh} className="btn-retry">Try again</button>
                  </>
                )}
                {metaEnvError && <p>{metaEnvError}</p>}
                {metaError && <p>Shared metadata: {metaError}</p>}
              </div>
            )}

            {loading && visibleArticles.length === 0 && (
              <div className="feed-loading">
                {[...Array(SKELETON_CARD_COUNT)].map((_, i) => (
                  <div key={i} className="skeleton-card" style={{ animationDelay: `${i * 0.1}s` }} />
                ))}
              </div>
            )}

            {filteredArticles.map((article, index) => (
              <Fragment key={article.id}>
                <ArticleCard
                  article={article}
                  prefs={prefs}
                  animateEnter={feedEnterIds.includes(article.id)}
                  priority={index === 0}
                  ogImageUrl={ogMap.get(article.id)}
                  articleLabelNames={articleTagsMap.get(article.id) ?? []}
                  isTagging={taggingArticleId === article.id}
                  onOpen={onOpen}
                  onSave={onSave}
                  onUpvote={onUpvote}
                  onDownvote={onDownvote}
                  onSeen={onSeen}
                  onAddManualTag={onAddManualTag}
                  onRemoveManualTag={onRemoveManualTag}
                  feedScoresLoading={feedScoresLoading}
                  feedScoreInsight={feedScoreInsightById?.get(article.id)}
                />
                {index === ogSentinelIndex && (
                  <div ref={ogSentinelRef} aria-hidden="true" />
                )}
              </Fragment>
            ))}

            {view === 'feed' && <div ref={sentinelRef} className="sentinel" aria-hidden="true" />}

            {!loading && !fetching && !hasMore && visibleArticles.length > 0 && view === 'feed' && !activeFilter && (
              <div className="feed-end">
                <span className="feed-end-icon">✓</span>
                <p>All caught up</p>
                <button className="btn-retry" onClick={onManualRefresh}>Refresh for more</button>
              </div>
            )}

            {!loading && !fetching && filteredArticles.length === 0 && !error && !metaEnvError && (
              <div className="feed-empty">
                {view === 'saved' ? (
                  prefs.savedIds.length > 0
                    ? <p>Loading queue…</p>
                    : <p className="queue-done">Queue cleared ✓</p>
                ) : activeFilter && hasMore ? null : (
                  <p>No articles match this filter.</p>
                )}
              </div>
            )}
          </>
        )}
      </main>

      {showSearch && (
        <SearchOverlay
          allArticles={allArticles}
          savedArticles={savedArticles}
          prefs={prefs}
          onOpen={onOpen}
          onSaveExternal={onSaveExternal}
          onUpvote={onUpvote}
          onDownvote={onDownvote}
          onClose={() => setShowSearch(false)}
          platformWorkerUrl={PLATFORM_WORKER_URL}
          backfilled={backfilled}
        />
      )}

      {showSettings && (
        <Settings
          prefs={prefs}
          onToggleSource={onToggleSource}
          onToggleTopic={onToggleTopic}
          onResetPrefs={onResetPrefs}
          onClearViewed={onClearViewed}
          onClose={() => setShowSettings(false)}
          onAddCustomSource={onAddCustomSource}
          onRemoveCustomSource={onRemoveCustomSource}
          onExportOPML={onExportOPML}
          onImportOPML={onImportOPML}
          onExportBookmarks={onExportBookmarks}
          onImportBookmarks={onImportBookmarks}
          onAddLabel={onAddLabel}
          onDeleteLabel={onDeleteLabel}
          onSuggestLabels={(articles) => suggestLabels(prefs, articles.length ? articles : visibleArticles)}
          syncActive={syncActive}
          syncStatus={syncStatus}
          syncedAt={syncedAt}
          syncError={syncError}
          syncErrorDetails={syncErrorDetails}
          syncUrl={syncUrl}
          syncEnvError={syncEnvError}
          metaStatus={metaStatus}
          metaError={metaError}
          metaEnvError={metaEnvError}
          onForceMetaSync={forceMetaSync}
          onForceSync={forceSync}
          onGenerateLink={generateLink}
          onRevoke={revoke}
          onToggleAiBar={onToggleAiBar}
          onToggleTheme={onToggleTheme}
        />
      )}
    </>
  );
}
