import { useCallback, useEffect, useRef, useState } from 'react';
import type { Article, UserPrefs } from '../types';
import { readHistoryEntries } from '../services/articleHistory';
import {
  buildCandidates, searchArticles,
  type HistoryCandidate, type SearchCandidate, type SearchScope,
} from '../services/articleSearch';
import { parseRecArticlesResponse } from '../services/recArticlesLookup';

interface Props {
  allArticles: Article[];
  savedArticles: Article[];
  prefs: UserPrefs;
  onOpen: (article: Article) => void;
  onClose: () => void;
  platformWorkerUrl: string;
  backfilled: boolean;
}

function timeAgoIso(iso: string): string {
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 604800) return `${Math.floor(secs / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const SCOPES: { label: string; value: SearchScope }[] = [
  { label: 'All', value: 'all' },
  { label: 'Feed', value: 'feed' },
  { label: 'Queue', value: 'queue' },
  { label: 'History', value: 'history' },
];

export function SearchOverlay({ allArticles, savedArticles, prefs, onOpen, onClose, platformWorkerUrl, backfilled }: Props) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<SearchScope>('all');
  const [results, setResults] = useState<SearchCandidate[]>([]);
  const [remoteResults, setRemoteResults] = useState<SearchCandidate[]>([]);
  const [history, setHistory] = useState<HistoryCandidate[]>([]);
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

  // Tier 1 debounce: ~150ms — pool + history (both instant at 500 entries)
  useEffect(() => {
    const timer = setTimeout(() => {
      const candidates = buildCandidates(allArticles, savedArticles, history);
      setResults(searchArticles(query, candidates, scope));
      setRemoteResults([]); // clear stale remote results on new query
    }, 150);
    return () => clearTimeout(timer);
  }, [query, scope, allArticles, savedArticles, history]);

  // Tier 2 debounce: ~400ms — remote lookup, only before backfill completes
  useEffect(() => {
    if (backfilled || !platformWorkerUrl || !query.trim()) return;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`${platformWorkerUrl}/rec/articles`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: Object.keys(prefs.unsavedAtById ?? {}).concat(prefs.readIds ?? []).slice(0, 500) }),
        });
        if (!res.ok) return;
        const data = parseRecArticlesResponse(await res.json());
        const remoteCandidates: SearchCandidate[] = data.articles.map(a => ({
          id: a.id,
          title: a.title,
          url: a.url,
          source: a.source,
          sourceId: a.sourceId,
          publishedAt: a.publishedAt,
          inPool: false,
          inQueue: false,
        }));
        setRemoteResults(searchArticles(query, remoteCandidates, scope));
      } catch {
        // ignore
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [query, scope, backfilled, platformWorkerUrl, prefs.unsavedAtById, prefs.readIds]);

  const articleById = useCallback((id: string): Article | undefined => {
    return allArticles.find(a => a.id === id) ?? savedArticles.find(a => a.id === id);
  }, [allArticles, savedArticles]);

  const handleResultClick = useCallback((c: SearchCandidate) => {
    if (c.inPool) {
      const article = articleById(c.id);
      if (article) { onOpen(article); onClose(); return; }
    }
    // History-only: open URL directly
    window.open(c.url, '_blank', 'noopener,noreferrer');
    onClose();
  }, [articleById, onOpen, onClose]);

  // Merge tier 1 + tier 2, pool-wins dedup
  const allResults = (() => {
    const seen = new Set(results.map(r => r.id));
    const extra = remoteResults.filter(r => !seen.has(r.id));
    return [...results, ...extra];
  })();

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

        <div className="search-results" role="list">
          {!q && (
            <p className="search-empty">Search your feed and reading history.</p>
          )}
          {q && allResults.length === 0 && (
            <p className="search-empty">No results for "{q}".</p>
          )}
          {allResults.map(r => (
            <button
              key={r.id}
              className={`search-result-item${!r.inPool ? ' search-result-history' : ''}`}
              onClick={() => handleResultClick(r)}
              role="listitem"
            >
              <span className="search-result-title">{r.title}</span>
              <span className="search-result-meta">
                {r.source} · {timeAgoIso(r.publishedAt)}
                {!r.inPool && <span className="search-result-badge">history</span>}
                {r.inQueue && <span className="search-result-badge">queued</span>}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
