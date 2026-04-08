import { useState, useMemo, useEffect, useRef } from 'react';
import { useFeed } from './hooks/useFeed';
import { ArticleCard } from './components/ArticleCard';
import { TopicFilter } from './components/TopicFilter';
import { Settings } from './components/Settings';
import type { Topic, FeedView } from './types';

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
    visibleArticles, hasMore, totalLoaded,
    loading, refreshing, loadingMore, error, prefs, lastRefresh,
    onOpen, onSave, onLoadMore,
    onToggleSource, onToggleTopic, onRefresh,
  } = useFeed();

  const [view, setView] = useState<FeedView>('feed');
  const [topicFilter, setTopicFilter] = useState<Topic | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  // Sentinel element watched by IntersectionObserver to trigger load-more
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || view !== 'feed') return;

    const observer = new IntersectionObserver(
      entries => {
        if (entries[0].isIntersecting && hasMore && !loading && !loadingMore) {
          onLoadMore();
        }
      },
      { rootMargin: '300px' } // start loading 300px before the bottom edge
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loading, loadingMore, onLoadMore, view]);

  const filteredArticles = useMemo(() => {
    let list = view === 'saved'
      ? visibleArticles.filter(a => prefs.savedIds.includes(a.id))
      : visibleArticles;
    if (topicFilter) {
      list = list.filter(a => a.topics.includes(topicFilter));
    }
    return list;
  }, [visibleArticles, view, topicFilter, prefs.savedIds]);

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
          Saved {prefs.savedIds.length > 0 && <span className="tab-count">{prefs.savedIds.length}</span>}
        </button>
      </nav>

      {view === 'feed' && (
        <TopicFilter
          prefs={prefs}
          activeFilter={topicFilter}
          onFilter={setTopicFilter}
        />
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

        {filteredArticles.map(article => (
          <ArticleCard
            key={article.id}
            article={article}
            prefs={prefs}
            onOpen={onOpen}
            onSave={onSave}
          />
        ))}

        {/* Sentinel — IntersectionObserver target */}
        {view === 'feed' && <div ref={sentinelRef} className="sentinel" aria-hidden="true" />}

        {/* Load-more skeleton */}
        {loadingMore && (
          <div className="feed-loading">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="skeleton-card" style={{ animationDelay: `${i * 0.08}s` }} />
            ))}
          </div>
        )}

        {/* All caught up */}
        {!loading && !loadingMore && !hasMore && visibleArticles.length > 0 && view === 'feed' && !topicFilter && (
          <div className="feed-end">
            <span className="feed-end-icon">✓</span>
            <p>All caught up</p>
            <button className="btn-retry" onClick={onRefresh}>Refresh for more</button>
          </div>
        )}

        {!loading && filteredArticles.length === 0 && !error && (
          <div className="feed-empty">
            {view === 'saved' ? (
              <p>No saved articles yet. Tap ☆ to bookmark.</p>
            ) : (
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
          onClose={() => setShowSettings(false)}
        />
      )}
    </>
  );
}
