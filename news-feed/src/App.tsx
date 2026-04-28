import { useState, useMemo, useEffect, useRef } from 'react';
import { useFeed } from './hooks/useFeed';
import { ArticleCard } from './components/ArticleCard';
import { TopicFilter } from './components/TopicFilter';
import { Settings } from './components/Settings';
import { suggestLabels } from './services/labelSuggester';
import { isPromptApiAvailable } from './services/labelClassifier';
import type { ActiveFilter, FeedView } from './types';

const PULL_THRESHOLD = 80; // px of downward drag to trigger refresh

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
  const {
    visibleArticles, savedArticles, hasMore, totalLoaded,
    loading, refreshing, fetching, error, prefs, lastRefresh, feedEnterIds,
    onOpen, onSave, onUpvote, onDownvote, onSeen, onLoadMore,
    onToggleSource, onToggleTopic, onResetPrefs, onClearViewed, onRefresh,
    onAddCustomSource, onRemoveCustomSource, onExportOPML, onImportOPML,
    onExportBookmarks, onImportBookmarks,
    articleTagsMap, classificationStatus, aiTaggingStarted, onStartAiTagging, onAddLabel, onDeleteLabel, syncShareUrl,
  } = useFeed();

  const [view, setView] = useState<FeedView>('feed');
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [pullProgress, setPullProgress] = useState(0); // 0–1
  const canUseBrowserAi = isPromptApiAvailable();

  // Keep a stable ref so the touch handlers always call the latest onRefresh
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

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
      list = list.filter(a => (articleTagsMap.get(a.id) ?? []).some(t => t.includes(labelName) || labelName.includes(t)));
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
            className="icon-btn"
            onClick={onRefresh}
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
      </div>

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
        {error && (
          <div className="feed-error">
            <p>{error}</p>
            <button onClick={onRefresh} className="btn-retry">Try again</button>
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
          <ArticleCard
            key={article.id}
            article={article}
            prefs={prefs}
            animateEnter={feedEnterIds.includes(article.id)}
            priority={index === 0}
            articleLabelNames={articleTagsMap.get(article.id) ?? []}
            onOpen={onOpen}
            onSave={onSave}
            onUpvote={onUpvote}
            onDownvote={onDownvote}
            onSeen={onSeen}
          />
        ))}

        {/* Sentinel — IntersectionObserver target */}
        {view === 'feed' && <div ref={sentinelRef} className="sentinel" aria-hidden="true" />}

        {/* All caught up */}
        {!loading && !fetching && !hasMore && visibleArticles.length > 0 && view === 'feed' && !activeFilter && (
          <div className="feed-end">
            <span className="feed-end-icon">✓</span>
            <p>All caught up</p>
            <button className="btn-retry" onClick={onRefresh}>Refresh for more</button>
          </div>
        )}

        {!loading && !fetching && filteredArticles.length === 0 && !error && (
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
          syncShareUrl={syncShareUrl}
        />
      )}
    </>
  );
}
