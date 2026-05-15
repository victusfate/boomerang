import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  fetchRecArticles,
  type RecResponseWithScores,
} from '../services/recWorker';
import { resolveWorkerUrl } from '../config/workerEnv';
import { articleCatalogMissingTitleLabel } from '../../../shared/articleRecordCatalog.ts';
import type { RecStatus } from '../hooks/useRecWorker';

const WORKER_BASE = resolveWorkerUrl(import.meta.env.VITE_REC_WORKER_URL);
const TOP_N = 25;

interface Props {
  recUserId?: string | null;
  recArticleIds: string[];
  recScoreById: Record<string, number>;
  recScoredArticles: RecResponseWithScores['scoredArticleIds'];
  recModelDiagnostics: RecResponseWithScores['diagnostics'] | null;
  recGeneratedAt: number | null;
  recStatus: RecStatus;
  getArticleTitle: (id: string) => string | null;
}

function RecUserIdBar({ userId }: { userId: string | null | undefined }) {
  const [copied, setCopied] = useState(false);

  const copyId = useCallback(async () => {
    if (!userId) return;
    try {
      await navigator.clipboard.writeText(userId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  }, [userId]);

  return (
    <div
      className="rec-user-id-bar rec-user-id-bar--footer"
      title="Collaborative filtering user id — used for /recommendations/:userId and /interactions"
    >
      <span className="rec-user-id-label">User id</span>
      <code
        className="rec-user-id-value"
        onClick={() => { void copyId(); }}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            void copyId();
          }
        }}
        role="button"
        tabIndex={userId ? 0 : -1}
        aria-label={userId ? `Recommendation user id ${userId}, click to copy` : 'Recommendation user id loading'}
      >
        {userId ?? 'Loading…'}
      </code>
      <button
        type="button"
        className="rec-user-id-copy"
        onClick={() => { void copyId(); }}
        disabled={!userId}
        aria-label="Copy recommendation user id"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function formatModelAge(generatedAt: number | null): string {
  if (!generatedAt) return 'unknown';
  const deltaMs = Date.now() - generatedAt;
  if (deltaMs < 0) return 'just now';
  const mins = Math.floor(deltaMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ago`;
}

export function RecDiagnostics({
  recUserId,
  recArticleIds,
  recScoreById,
  recScoredArticles,
  recModelDiagnostics,
  recGeneratedAt,
  recStatus,
  getArticleTitle,
}: Props) {
  const [lookupTitleById, setLookupTitleById] = useState<Record<string, string>>({});
  const settledLookupIdsRef = useRef(new Set<string>());
  const inFlightLookupKeyRef = useRef<string | null>(null);

  const topRated = useMemo(() => {
    if (recScoredArticles.length > 0) {
      return [...recScoredArticles]
        .sort((a, b) => b.score - a.score || a.articleId.localeCompare(b.articleId))
        .slice(0, TOP_N)
        .map((row, idx) => ({
          id: row.articleId,
          rank: idx + 1,
          score: row.score,
        }));
    }
    return recArticleIds
      .map(id => ({ id, score: recScoreById[id] }))
      .filter((row): row is { id: string; score: number } =>
        typeof row.score === 'number' && Number.isFinite(row.score))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, TOP_N)
      .map((row, idx) => ({ ...row, rank: idx + 1 }));
  }, [recScoredArticles, recArticleIds, recScoreById]);

  const titleLookupKey = useMemo(
    () => topRated.map(r => r.id).join(','),
    [topRated],
  );

  useEffect(() => {
    if (!titleLookupKey || !WORKER_BASE) return;
    const ids = titleLookupKey.split(',').filter(Boolean);
    const missingIds = ids.filter(
      id => !getArticleTitle(id)
        && !lookupTitleById[id]
        && !settledLookupIdsRef.current.has(id),
    );
    if (missingIds.length === 0) return;

    const batchKey = missingIds.slice().sort().join(',');
    if (inFlightLookupKeyRef.current === batchKey) return;
    inFlightLookupKeyRef.current = batchKey;

    void fetchRecArticles(WORKER_BASE, missingIds)
      .then((response) => {
        inFlightLookupKeyRef.current = null;
        for (const id of missingIds) settledLookupIdsRef.current.add(id);
        if (response.articles.length > 0) {
          setLookupTitleById(prev => ({
            ...prev,
            ...Object.fromEntries(response.articles.map(a => [a.id, a.title])),
          }));
        }
      })
      .catch(() => {
        inFlightLookupKeyRef.current = null;
        for (const id of missingIds) settledLookupIdsRef.current.add(id);
      });
  }, [titleLookupKey, getArticleTitle, lookupTitleById]);

  const scoreValues = topRated.map(e => e.score);
  const minScore = scoreValues.length > 0 ? Math.min(...scoreValues) : 0;
  const maxScore = scoreValues.length > 0 ? Math.max(...scoreValues) : 1;
  const scoreSpan = maxScore - minScore;

  const statusDot = recStatus === 'active' ? 'active' : recStatus === 'error' ? 'error' : 'idle';
  const coldLabel = recModelDiagnostics?.coldStart ? ' · cold start' : '';

  return (
    <div className="rec-diag">
      <div className="rec-diag-main">
        <div className="rec-status-row">
          <span className={`sync-dot sync-dot--${statusDot}`} />
          <span className="settings-hint" style={{ margin: 0 }}>
            {topRated.length > 0
              ? `Top ${topRated.length} by MF score`
              : recStatus === 'active' ? 'Waiting for rankings…' : 'Ranking offline'}
            {recModelDiagnostics?.candidateCount != null && topRated.length > 0
              ? ` · ${recModelDiagnostics.candidateCount} candidates`
              : ''}
            {coldLabel}
          </span>
          <span className="rec-status-sep" />
          <span className="settings-hint" style={{ margin: 0 }}>
            Updated {formatModelAge(recGeneratedAt)}
          </span>
        </div>

        {topRated.length > 0 ? (
          <>
            <p className="settings-hint" style={{ marginBottom: 4 }}>
              Highest collaborative scores from your current feed pool. Per-card breakdowns are on the Feed tab.
            </p>
            <div className="rec-cf-list">
              {topRated.map(entry => {
                const pct = scoreSpan <= 1e-9
                  ? 100
                  : ((entry.score - minScore) / scoreSpan) * 100;
                const title = getArticleTitle(entry.id)
                  ?? lookupTitleById[entry.id]
                  ?? articleCatalogMissingTitleLabel();
                return (
                  <div key={entry.id} className="rec-cf-row">
                    <div className="rec-cf-header">
                      <span className="rec-cf-rank">#{entry.rank}</span>
                      <span className="rec-cf-score">s{entry.score.toFixed(3)}</span>
                    </div>
                    <div className="rec-cf-title" title={title}>{title}</div>
                    <div className="rec-cf-track">
                      <div className="rec-cf-fill" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <p className="settings-hint">
            {recStatus === 'error'
              ? 'Could not load rankings — check the worker and try refreshing the feed.'
              : recStatus === 'disabled'
                ? 'Recommendations are disabled (missing worker URL).'
                : 'No scores yet. Load the feed and interact with articles to train the model.'}
          </p>
        )}
      </div>

      <RecUserIdBar userId={recUserId} />
    </div>
  );
}
