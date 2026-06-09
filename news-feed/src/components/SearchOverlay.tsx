import { useCallback, useEffect, useRef, useState } from 'react';
import type { Article, UserPrefs } from '../types';
import { readHistoryEntries } from '../services/articleHistory';
import {
  buildCandidates, searchArticles,
  type HistoryCandidate, type SearchCandidate, type SearchScope,
} from '../services/articleSearch';
import { parseRecArticlesResponse } from '../services/recArticlesLookup';
import { normalizeArticleNavUrl } from '../services/articleNavUrl';
import { timeAgo } from '../services/timeAgo';

interface Props {
  allArticles: Article[];
  savedArticles: Article[];
  prefs: UserPrefs;
  onOpen: (article: Article) => void;
  onSave: (id: string) => void;
  onUpvote: (article: Article) => void;
  onDownvote: (article: Article) => void;
  onClose: () => void;
  platformWorkerUrl: string;
  backfilled: boolean;
}

const SCOPES: { label: string; value: SearchScope }[] = [
  { label: 'All', value: 'all' },
  { label: 'Feed', value: 'feed' },
  { label: 'Queue', value: 'queue' },
  { label: 'History', value: 'history' },
];

export function SearchOverlay({ allArticles, savedArticles, prefs, onOpen, onSave, onUpvote, onDownvote, onClose, platformWorkerUrl, backfilled }: Props) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<SearchScope>('all');
  const [results, setResults] = useState<SearchCandidate[]>([]);
  const [history, setHistory] = useState<HistoryCandidate[]>([]);
  // Remote candidates resolved once per mount during the backfill window —
  // the response is query-independent, so filtering happens locally.
  const [remoteCandidates, setRemoteCandidates] = useState<HistoryCandidate[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load history once on mount
  useEffect(() => {
    void readHistoryEntries().then(entries =>
      setHistory(entries.map(e => ({
        id: e.id,
        title: e.title,
        url: e.url,
        source: e.source,
        publishedAt: e.publishedAt,
      })))
    );
  }, []);

  // Backfill window only: resolve prior interaction IDs remotely, once.
  useEffect(() => {
    if (backfilled || !platformWorkerUrl) return;
    const controller = new AbortController();
    const ids = Object.keys(prefs.unsavedAtById ?? {}).concat(prefs.readIds ?? []).slice(0, 500);
    if (ids.length === 0) return;
    void (async () => {
      try {
        const res = await fetch(`${platformWorkerUrl}/rec/articles`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = parseRecArticlesResponse(await res.json());
        setRemoteCandidates(data.articles.map(a => ({
          id: a.id,
          title: a.title,
          url: a.url,
          source: a.source,
          publishedAt: a.publishedAt,
        })));
      } catch {
        // aborted or network failure — local results still work
      }
    })();
    return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backfilled, platformWorkerUrl]); // prefs snapshot at mount is intentional

  // Auto-focus on open
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Single ~150ms debounce — pool, queue, local history, and any remote
  // backfill candidates are all filtered locally.
  useEffect(() => {
    const timer = setTimeout(() => {
      const candidates = buildCandidates(allArticles, savedArticles, [...history, ...remoteCandidates]);
      setResults(searchArticles(query, candidates, scope));
    }, 150);
    return () => clearTimeout(timer);
  }, [query, scope, allArticles, savedArticles, history, remoteCandidates]);

  const articleById = useCallback((id: string): Article | undefined => {
    return allArticles.find(a => a.id === id) ?? savedArticles.find(a => a.id === id);
  }, [allArticles, savedArticles]);

  const handleResultClick = useCallback((c: SearchCandidate) => {
    if (c.inPool) {
      const article = articleById(c.id);
      if (article) {
        onOpen(article); // bookkeeping: mark read, boost topics, record interaction
        const url = normalizeArticleNavUrl(article.url);
        if (url) window.open(url, '_blank', 'noopener,noreferrer');
        onClose();
        return;
      }
    }
    // History-only: open URL directly (normalized — stored URLs may carry &amp; or bad protocols)
    const url = normalizeArticleNavUrl(c.url);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
    onClose();
  }, [articleById, onOpen, onClose]);

  const q = query.trim();

  return (
    <div className="search-overlay" role="dialog" aria-modal="true" aria-label="Search">
      <div className="search-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="search-panel">
        <div className="search-input-row">
          <input
            ref={inputRef}
            className="search-input"
            type="search"
            placeholder="Search articles…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            aria-label="Search query"
          />
          <button className="search-close icon-btn" onClick={onClose} aria-label="Close search">✕</button>
        </div>

        <div className="search-chips" role="group" aria-label="Filter">
          {SCOPES.map(s => (
            <button
              key={s.value}
              className={`topic-pill${scope === s.value ? ' active' : ''}`}
              onClick={() => setScope(s.value)}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="search-results">
          {!q && (
            <p className="search-empty">Search your feed and reading history.</p>
          )}
          {q && results.length === 0 && (
            <p className="search-empty">No results for "{q}".</p>
          )}
          {results.map(r => {
            const article = r.inPool ? articleById(r.id) : undefined;
            const saved    = prefs.savedIds.includes(r.id);
            const votedUp  = prefs.upvotedIds.includes(r.id);
            const votedDown = prefs.downvotedIds.includes(r.id);
            return (
              <div
                key={r.id}
                className={`search-result-item${!r.inPool ? ' search-result-history' : ''}`}
              >
                <button className="search-result-body" onClick={() => handleResultClick(r)}>
                  <span className="search-result-title">{r.title}</span>
                  <span className="search-result-meta">
                    {r.source} · {timeAgo(new Date(r.publishedAt), 'ago')}
                    {!r.inPool && <span className="search-result-badge">history</span>}
                    {r.inQueue && <span className="search-result-badge">queued</span>}
                  </span>
                </button>
                {article && (
                  <div className="search-result-actions">
                    <button
                      className={`btn-vote btn-upvote${votedUp ? ' active' : ''}`}
                      onClick={() => onUpvote(article)}
                      aria-label={votedUp ? 'Remove upvote' : 'More like this'}
                      title={votedUp ? 'Remove upvote' : 'More like this'}
                    >▲</button>
                    <button
                      className={`btn-save${saved ? ' saved' : ''}`}
                      onClick={() => onSave(r.id)}
                      aria-label={saved ? 'Remove bookmark' : 'Bookmark'}
                      title={saved ? 'Remove bookmark' : 'Bookmark'}
                    >{saved ? '★' : '☆'}</button>
                    <button
                      className={`btn-vote btn-downvote${votedDown ? ' active' : ''}`}
                      onClick={() => onDownvote(article)}
                      aria-label={votedDown ? 'Remove downvote' : 'Less like this'}
                      title={votedDown ? 'Remove downvote' : 'Less like this'}
                    >▼</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
