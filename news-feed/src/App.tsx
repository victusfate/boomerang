import { useState, useMemo, useEffect, useRef, useCallback, Fragment } from 'react';
import { useFeed } from './hooks/useFeed';
import { useSyncWorker, type SyncStatus } from './hooks/useSyncWorker';
import { useMetaWorker } from './hooks/useMetaWorker';
import { useOGImageBatch } from './hooks/useOGImageBatch';
import { ArticleCard } from './components/ArticleCard';
import { TopicFilter } from './components/TopicFilter';
import { Settings } from './components/Settings';
import { suggestLabels } from './services/labelSuggester';
import { isPromptApiAvailable } from './services/labelClassifier';
import { sameIdsInOrder } from './services/metaSyncTrigger';
import type { ActiveFilter, FeedView } from './types';

const PULL_THRESHOLD = 80; // px of downward drag to trigger refresh

type SyncIndicatorState = 'idle' | 'setup' | 'active' | 'syncing' | 'error';

function formatRelativeMinutes(date: Date): string {
  const mins = Math.floor((Date.now() - date.getTime()) / 60000);
  return mins < 1 ? 'just now' : `${mins}m ago`;
}

function formatCooldownLabel(remainingMs: number): string {
  return `Cooldown ${Math.max(1, Math.ceil(remainingMs / 1000))}s`;
}

function syncIndicatorState(
  syncActive: boolean,
  syncStatus: SyncStatus,
  metaStatus: 'disabled' | 'active' | 'syncing' | 'error',
  syncedAt: Date | null,
  syncError: string | null,
  syncEnvError: string | null,
  cooldownMs: number,
): { state: SyncIndicatorState; label: string; title: string } {
  if (syncError || syncStatus === 'error') {
    return { state: 'error', label: 'Sync error', title: syncError ?? 'Sync failed' };
  }
  if (syncStatus === 'syncing' || metaStatus === 'syncing') {
    return { state: 'syncing', label: 'Syncing...', title: 'Pulling or pushing sync data' };
  }
  if (cooldownMs > 0) {
    return {
      state: 'active',
      label: formatCooldownLabel(cooldownMs),
      title: `Sync cooldown active (${Math.ceil(cooldownMs / 1000)}s remaining)`,
    };
  }
  if (syncActive) {
    const label = syncedAt ? `Synced ${formatRelativeMinutes(syncedAt)}` : 'Sync on';
    return { state: 'active', label, title: 'Sync is active.' };
  }
  if (syncEnvError) {
    return { state: 'setup', label: 'Sync setup', title: syncEnvError };
  }
  return { state: 'idle', label: 'Sync off', title: 'Sync is not active. Open Settings to generate a link.' };
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      style={{ animation: spinning ? 'spin 1s linear infinite' : 'none' }}
      aria-hidden="true"
    >
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}

export default function App() {
  // Meta hook runs first: useFeed needs its callbacks + live tag map from the worker.
  const [articleIds, setArticleIds] = useState<string[]>([]);
  const {
    metaTagsMap, feedTaggedArticle, endTaggingPass, forceMetaSync, metaStatus, metaError, metaEnvError, metaSyncCooldownMs,
  } = useMetaWorker(articleIds);

  const {
    visibleArticles, savedArticles, hasMore, totalLoaded,
    loading, refreshing, fetching, error, prefs, lastRefresh, feedEnterIds,
    onOpen, onSave, onUpvote, onDownvote, onSeen, onLoadMore,
    onToggleSource, onToggleTopic, onResetPrefs, onClearViewed, onRefresh,
    onAddCustomSource, onRemoveCustomSource, onExportOPML, onImportOPML,
    onExportBookmarks, onImportBookmarks,
    articleTagsMap, classificationStatus, aiTaggingStarted, taggingArticleId, onStartAiTagging, onAddLabel, onDeleteLabel,
    labelHits, articleTags, onToggleAiBar, onAddManualTag, onRemoveManualTag,
    onRemoteSync, syncReady,
  } = useFeed({ metaCallbacks: { feedTaggedArticle, endTaggingPass }, metaTagsMap });

  const { syncActive, syncStatus, syncedAt, syncError, syncUrl, syncEnvError, syncCooldownMs, forceSync, generateLink, revoke } =
    useSyncWorker(prefs, articleTags, labelHits, savedArticles, onRemoteSync, syncReady);

  const [view, setView] = useState<FeedView>('feed');
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [pullProgress, setPullProgress] = useState(0); // 0–1
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
  const initialSyncDoneRef = useRef(false);

  // Drive metadata sync target ids in useMetaWorker. `visibleArticles` is a fresh array every
  // render (useFeed does `allArticles.slice(0, visibleCount)`), so comparing by value and
  // returning `prev` avoids setState → render → setState loops.
  useEffect(() => {
    const nextIds = visibleArticles.map(a => a.id);
    setArticleIds(prev => (sameIdsInOrder(prev, nextIds) ? prev : nextIds));
  }, [visibleArticles]);

  const forceMetaSyncRef = useRef(forceMetaSync);
  forceMetaSyncRef.current = forceMetaSync;

  // Pull shared metadata for visible cards even when sync-worker is not enabled.
  useEffect(() => {
    if (articleIds.length === 0) return;
    void forceMetaSyncRef.current();
  }, [articleIds]);

  // On initial load, trigger sync-worker pull+push for sync users.
  // Meta tags for all users are already pulled by the articleIds effect above.
  useEffect(() => {
    if (initialSyncDoneRef.current) return;
    if (!syncActive) return;
    if (!syncReady) return;
    initialSyncDoneRef.current = true;
    void forceSync();
  }, [syncActive, syncReady, forceSync]);

  // Re-fetch shared metadata for all users (and full sync for sync users) whenever the
  // tab becomes active again. Uses forceMetaSyncRef to avoid dep churn from the 500ms
  // cooldown ticker that recreates forceMetaSync on every tick.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void forceMetaSyncRef.current();
      if (syncActive && syncReady) void forceSync();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [forceSync, syncActive, syncReady]);

  // Keep a stable ref so the touch handlers always call the latest refresh handler
  const onRefreshRef = useRef(onManualRefresh);
  onRefreshRef.current = onManualRefresh;

  // Gesture state stored in a ref to avoid re-renders during drag
  const pullGestureRef = useRef({ active: false, startY: 0, progress: 0 });

  useEffect(() => {
    if (showSettings) return; // don't capture gestures when settings modal is open
    let triggered = false;

    const onTouchStart = (e: TouchEvent) => {
      if (window.scrollY > 5) return; // only activate at top of page
      pullGestureRef.current = { active: true, startY: e.touches[0].clientY, progress: 0 };
      triggered = false;
    };

    const onTouchMove = (e: TouchEvent) => {
      const g = pullGestureRef.current;
      if (!g.active) return;
      const delta = e.touches[0].clientY - g.startY;
      if (delta <= 0) { g.active = false; setPullProgress(0); return; }
      const progress = Math.min(delta / PULL_THRESHOLD, 1);
      g.progress = progress;
      setPullProgress(progress);
      // Prevent native scroll-bounce while we're handling the pull
      if (window.scrollY <= 5) e.preventDefault();
    };

    const onTouchEnd = () => {
      const g = pullGestureRef.current;
      if (!g.active) return;
      const willRefresh = g.progress >= 1 && !triggered;
      g.active = false;
      g.progress = 0;
      setPullProgress(0);
      if (willRefresh) { triggered = true; onRefreshRef.current(); }
    };

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, [showSettings]); // pullGestureRef is stable; onRefreshRef is kept current above

  // Sentinel element watched by IntersectionObserver to trigger load-more.
  // The callback is kept in a ref so the observer itself is only created once
  // per view-change — avoids continuous disconnect/reconnect as state updates.
  const sentinelRef = useRef<HTMLDivElement>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || view !== 'feed') return;

    const observer = new IntersectionObserver(
      entries => { if (entries[0].isIntersecting) onLoadMoreRef.current(); },
      { rootMargin: '600px' } // start loading well before the bottom edge
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [view]); // only recreate when switching views

  // When new articles arrive (totalLoaded grows), the sentinel may already be
  // inside the IntersectionObserver's rootMargin zone, so no new IO event fires.
  // Manually call loadMore whenever the pool grows and the sentinel is still visible.
  const prevTotalRef = useRef(0);
  useEffect(() => {
    if (totalLoaded <= prevTotalRef.current) return;
    prevTotalRef.current = totalLoaded;
    if (!hasMore || view !== 'feed') return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const rect = sentinel.getBoundingClientRect();
    if (rect.top <= window.innerHeight + 600) {
      onLoadMore();
    }
  }, [totalLoaded, hasMore, view, onLoadMore]);


  const filteredArticles = useMemo(() => {
    let list = view === 'saved' ? savedArticles : visibleArticles;
    if (activeFilter?.kind === 'topic') list = list.filter(a => a.topics.includes(activeFilter.value));
    if (activeFilter?.kind === 'label') {
      const labelName = (prefs.userLabels ?? []).find(l => l.id === activeFilter.value)?.name?.toLowerCase() ?? '';
      list = list.filter(a => (articleTagsMap.get(a.id) ?? []).some((t: string) => t.includes(labelName) || labelName.includes(t)));
    }
    return list;
  }, [visibleArticles, savedArticles, view, activeFilter, articleTagsMap, prefs.userLabels]);

  // When a topic filter is active and the visible slice has no matches yet,
  // automatically load more so the user isn't stuck on a false empty state.
  useEffect(() => {
    if (activeFilter?.kind !== 'topic' || view !== 'feed') return;
    if (fetching || loading || !hasMore) return;
    if (filteredArticles.length === 0) onLoadMore();
  }, [activeFilter, view, fetching, loading, hasMore, filteredArticles.length, onLoadMore]);

  const { ogMap, sentinelRef: ogSentinelRef, fetchedUpTo: ogFetchedUpTo } =
    useOGImageBatch(filteredArticles, 10);

  function formatLastRefresh() {
    if (!lastRefresh) return '';
    const mins = Math.floor((Date.now() - lastRefresh.getTime()) / 60000);
    return mins < 1 ? 'just now' : `${mins}m ago`;
  }

  return (
    <>
      <header className="app-header">
        <div className="header-left">
          <h1 className="app-title">News</h1>
          {lastRefresh && (
            <span className="last-refresh">
              {refreshing ? 'Refreshing…' : formatLastRefresh()}
            </span>
          )}
        </div>
        <div className="header-right">
          <button
            type="button"
            className={`sync-indicator ${syncIndicator.state}`}
            onClick={onMainSyncClick}
            disabled={combinedSyncCooldownMs > 0 || syncIndicator.state === 'syncing'}
            title={syncIndicator.title}
            aria-label="Sync now"
          >
            <span className="sync-indicator-dot" aria-hidden="true" />
            <span>{syncIndicator.label}</span>
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
          Saved {savedArticles.length > 0 && <span className="tab-count">{savedArticles.length}</span>}
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

      {!prefs.hideAiBar && (
        <div className="ai-status" aria-live="polite">
          <span className={`ai-status-dot ${classificationStatus ? '' : 'idle'}`} />
          {classificationStatus || 'Chrome AI tagging'}
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

      {pullProgress > 0 && (
        <div className="pull-indicator">
          <div
            className="pull-indicator-inner"
            style={{ opacity: pullProgress, transform: `scale(${0.5 + pullProgress * 0.5})` }}
          >
            <RefreshIcon spinning={pullProgress >= 1} />
          </div>
        </div>
      )}

      <main className="feed">
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

        {/* Initial skeleton loading */}
        {loading && visibleArticles.length === 0 && (
          <div className="feed-loading">
            {[...Array(5)].map((_, i) => (
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
            />
            {index === Math.min(ogFetchedUpTo, filteredArticles.length) - 1 && (
              <div ref={ogSentinelRef} aria-hidden="true" />
            )}
          </Fragment>
        ))}

        {/* Sentinel — IntersectionObserver target */}
        {view === 'feed' && <div ref={sentinelRef} className="sentinel" aria-hidden="true" />}

        {/* All caught up */}
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
                ? <p>Loading saved articles…</p>
                : <p>No saved articles yet. Tap ☆ to bookmark.</p>
            ) : activeFilter && hasMore ? null : (
              <p>No articles match this filter.</p>
            )}
          </div>
        )}
      </main>

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
        />
      )}
    </>
  );
}
