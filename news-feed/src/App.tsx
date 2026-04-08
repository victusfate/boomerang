import { useState, useMemo } from 'react';
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
    articles, loading, error, prefs, lastRefresh,
    onOpen, onSave, onToggleSource, onToggleTopic, onRefresh,
  } = useFeed();

  const [view, setView] = useState<FeedView>('feed');
  const [topicFilter, setTopicFilter] = useState<Topic | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const filteredArticles = useMemo(() => {
    let list = view === 'saved'
      ? articles.filter(a => prefs.savedIds.includes(a.id))
      : articles;
    if (topicFilter) {
      list = list.filter(a => a.topics.includes(topicFilter));
    }
    return list;
  }, [articles, view, topicFilter, prefs.savedIds]);

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
            <span className="last-refresh">{formatLastRefresh()}</span>
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
            <p>Some sources failed to load.</p>
            <button onClick={onRefresh} className="btn-retry">Try again</button>
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

        {filteredArticles.map(article => (
          <ArticleCard
            key={article.id}
            article={article}
            prefs={prefs}
            onOpen={onOpen}
            onSave={onSave}
          />
        ))}

        {loading && filteredArticles.length === 0 && (
          <div className="feed-loading">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="skeleton-card" />
            ))}
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
