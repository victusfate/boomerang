import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { loadRecStats, engagementScore, ACTION_WEIGHT, type ActionCounts } from '../services/recStats';
import {
  fetchRecArticles,
  fetchRecDiagnostics,
  type RecArticlesResponse,
  type RecDebugInfo,
  type RecResponseWithScores,
} from '../services/recWorker';
import { PLATFORM_WORKER_URL } from '../config/workerEnv';
import { articleCatalogMissingTitleLabel } from '../../../shared/articleRecordCatalog.ts';
import { TOPIC_META } from './topicFilterUtils';
import type { RecStatus } from '../hooks/useRecWorker';
import type { Topic } from '../types';

const TOP_N = 25;

const ACTION_ORDER = ['save', 'upvote', 'read', 'seen', 'downvote'] as const;
type Action = typeof ACTION_ORDER[number];

const ACTION_COLOR: Record<Action, string> = {
  save:     '#6c63ff',
  upvote:   '#4caf50',
  read:     '#4a9eff',
  seen:     '#555',
  downvote: '#f44336',
};

const ACTION_LABEL: Record<Action, string> = {
  save:     'saved',
  upvote:   '↑',
  read:     'read',
  seen:     'seen',
  downvote: '↓',
};

interface Props {
  recUserId?: string | null;
  recArticleIds: string[];
  recScoreById: Record<string, number>;
  recScoredArticles: RecResponseWithScores['scoredArticleIds'];
  recModelDiagnostics: RecResponseWithScores['diagnostics'] | null;
  recTrace: RecResponseWithScores['trace'] | null;
  recCacheInfo: RecResponseWithScores['cache'] | null;
  recTimingMs: RecResponseWithScores['timingMs'] | null;
  recGeneratedAt: number | null;
  recStatus: RecStatus;
  getSourceName: (sourceId: string) => string;
  getArticleTitle: (id: string) => string | null;
}

interface DiagData {
  stats: Awaited<ReturnType<typeof loadRecStats>>;
  debug: RecDebugInfo | null;
}

function counts(c: ActionCounts, action: Action): number {
  return (c as Record<string, number>)[action] ?? 0;
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

function SourceRow({ name, c, score, maxScore }: {
  name: string;
  c: ActionCounts;
  score: number;
  maxScore: number;
}) {
  const barPct = maxScore > 0 ? Math.abs(score) / maxScore * 100 : 0;
  const isNeg  = score < 0;

  const chips = ACTION_ORDER.filter(a => counts(c, a) > 0);

  return (
    <div className="rec-source-row">
      <div className="rec-source-header">
        <span className="rec-source-name" title={name}>{name}</span>
        <span className={`rec-source-score${isNeg ? ' rec-source-score--neg' : ''}`}>
          {score > 0 ? '+' : ''}{score.toFixed(1)}
        </span>
      </div>
      <div className="rec-source-track">
        {isNeg ? (
          <div className="rec-source-fill-neg" style={{ width: `${barPct}%` }} />
        ) : (
          <div className="rec-source-fill-stack" style={{ width: `${barPct}%` }}>
            {ACTION_ORDER.map(action => {
              const n = counts(c, action);
              const weight = ACTION_WEIGHT[action] ?? 0;
              const contribution = n * weight;
              if (contribution <= 0) return null;
              const segPct = contribution / score * 100;
              return (
                <div
                  key={action}
                  className="rec-source-segment"
                  style={{ width: `${segPct}%`, background: ACTION_COLOR[action] }}
                  title={`${action} ×${n} → +${contribution.toFixed(1)} pts`}
                />
              );
            })}
          </div>
        )}
      </div>
      {chips.length > 0 && (
        <div className="rec-source-chips">
          {chips.map(action => (
            <span key={action} className="rec-source-chip" style={{ color: ACTION_COLOR[action] }}>
              {counts(c, action)} {ACTION_LABEL[action]}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function TopicBar({ label, color, score, maxScore }: {
  label: string; color?: string; score: number; maxScore: number;
}) {
  const pct = maxScore > 0 ? Math.max(0, score / maxScore) * 100 : 0;
  return (
    <div className="rec-topic-row">
      <span className="rec-topic-name">{label}</span>
      <div className="rec-topic-track">
        <div className="rec-topic-fill" style={{ width: `${pct}%`, background: color ?? 'var(--accent)' }} />
      </div>
      <span className="rec-topic-score">{score.toFixed(1)}</span>
    </div>
  );
}

export function RecDiagnostics({
  recUserId,
  recArticleIds,
  recScoreById,
  recScoredArticles,
  recModelDiagnostics,
  recTrace,
  recCacheInfo,
  recTimingMs,
  recGeneratedAt,
  recStatus,
  getSourceName,
  getArticleTitle,
}: Props) {
  const [data, setData]       = useState<DiagData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [lookupTitleById, setLookupTitleById] = useState<Record<string, string>>({});
  const [lookupCoverage, setLookupCoverage] = useState<Pick<RecArticlesResponse, 'found' | 'requested' | 'missing' | 'timingMs'> | null>(null);
  const settledLookupIdsRef = useRef(new Set<string>());
  const inFlightLookupKeyRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [stats, debug] = await Promise.all([
        loadRecStats(),
        PLATFORM_WORKER_URL
          ? fetchRecDiagnostics(PLATFORM_WORKER_URL).catch(() => null)
          : Promise.resolve(null),
      ]);
      setData({ stats, debug });
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
    if (!titleLookupKey || !PLATFORM_WORKER_URL) return;
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

    void fetchRecArticles(PLATFORM_WORKER_URL, missingIds)
      .then((response) => {
        inFlightLookupKeyRef.current = null;
        for (const id of missingIds) settledLookupIdsRef.current.add(id);
        setLookupCoverage({
          found: response.found,
          requested: response.requested,
          missing: response.missing,
          timingMs: response.timingMs,
        });
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

  const previewIds = topRated.map(entry => entry.id);
  const resolvedTitleCount = previewIds.filter(
    id => Boolean(getArticleTitle(id) || lookupTitleById[id]),
  ).length;
  const titleLookupHint = lookupCoverage
    ? `Resolved ${resolvedTitleCount}/${previewIds.length} titles`
      + (lookupCoverage.missing.length > 0 ? ` (${lookupCoverage.missing.length} missing)` : '')
      + (lookupCoverage.timingMs ? ` · ${Math.round(lookupCoverage.timingMs.total)}ms` : '')
    : previewIds.length > 0
      ? `Resolved ${resolvedTitleCount}/${previewIds.length} titles`
      : null;

  let sourceEntries: { id: string; name: string; c: ActionCounts; score: number }[] = [];
  let topicEntries: { topic: string; score: number }[] = [];
  let tagEntries: { tag: string; score: number }[] = [];
  let maxSource = 1;
  let maxTopic = 1;
  let maxTag = 1;
  if (data) {
    sourceEntries = Object.entries(data.stats.sources)
      .map(([id, c]) => ({ id, name: getSourceName(id), c, score: engagementScore(c) }))
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
      .slice(0, 12);
    topicEntries = Object.entries(data.stats.topics)
      .map(([topic, c]) => ({ topic, score: engagementScore(c) }))
      .filter(e => e.score > 0)
      .sort((a, b) => b.score - a.score);
    tagEntries = Object.entries(data.stats.tags ?? {})
      .map(([tag, c]) => ({ tag, score: engagementScore(c) }))
      .filter(e => e.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);
    maxSource = sourceEntries[0] ? Math.abs(sourceEntries[0].score) : 1;
    maxTopic = topicEntries[0]?.score || 1;
    maxTag = tagEntries[0]?.score   || 1;
  }

  if (loading && !data) {
    return (
      <div className="rec-diag">
        <div className="rec-diag-main">
          <p className="settings-hint">Loading ranking diagnostics…</p>
        </div>
        <RecUserIdBar userId={recUserId} />
      </div>
    );
  }
  if (error) {
    return (
      <div className="rec-diag">
        <div className="rec-diag-main">
          <p className="sync-error">{error}</p>
          <button type="button" className="btn-add-source" onClick={() => { void load(); }}>Retry</button>
        </div>
        <RecUserIdBar userId={recUserId} />
      </div>
    );
  }

  return (
    <div className="rec-diag">
      <div className="rec-diag-main">
        <div className="rec-status-row">
          <span className={`sync-dot sync-dot--${statusDot}`} />
          <span className="settings-hint" style={{ margin: 0 }}>
            {data?.debug
              ? `${data.debug.interactionsCount.count.toLocaleString()} remote interactions`
              : data
                ? `${data.stats.total.toLocaleString()} local interactions`
                : '—'}
          </span>
          <span className="rec-status-sep" />
          <span className="settings-hint" style={{ margin: 0 }}>
            {topRated.length > 0
              ? `Top ${topRated.length} by MF score`
              : recArticleIds.length > 0
                ? `${recArticleIds.length} ranked`
                : recStatus === 'active' ? 'Waiting for rankings…' : 'Ranking offline'}
            {recModelDiagnostics?.candidateCount != null && topRated.length > 0
              ? ` · ${recModelDiagnostics.candidateCount} candidates`
              : ''}
            {coldLabel}
          </span>
          <span className="rec-status-sep" />
          <span className="settings-hint" style={{ margin: 0 }}>
            Model {formatModelAge(recGeneratedAt)}
          </span>
          <button type="button" className="rec-diag-reload" onClick={() => { void load(); }} title="Refresh local stats &amp; model info" disabled={loading}>
            ↺
          </button>
        </div>

        {(recModelDiagnostics || recCacheInfo || recTimingMs || recTrace) && (
          <>
            <p className="rec-chart-title" style={{ marginTop: 16 }}>CF request</p>
            <div className="rec-observability-grid">
              {recModelDiagnostics && (
                <>
                  <div className="rec-observability-item">
                    <span className="rec-observability-label">model</span>
                    <span className="rec-observability-value">{recModelDiagnostics.modelVersion}</span>
                  </div>
                  <div className="rec-observability-item">
                    <span className="rec-observability-label">candidates</span>
                    <span className="rec-observability-value">{recModelDiagnostics.candidateCount}</span>
                  </div>
                  <div className="rec-observability-item">
                    <span className="rec-observability-label">ranked</span>
                    <span className="rec-observability-value">{recModelDiagnostics.rankedCount}</span>
                  </div>
                  <div className="rec-observability-item">
                    <span className="rec-observability-label">excluded downvotes</span>
                    <span className="rec-observability-value">{recModelDiagnostics.excludedDownvotes}</span>
                  </div>
                  <div className="rec-observability-item">
                    <span className="rec-observability-label">cold start</span>
                    <span className="rec-observability-value">{recModelDiagnostics.coldStart ? 'yes' : 'no'}</span>
                  </div>
                </>
              )}
              {recCacheInfo && (
                <>
                  <div className="rec-observability-item">
                    <span className="rec-observability-label">cache</span>
                    <span className="rec-observability-value">{recCacheInfo.status}</span>
                  </div>
                  <div className="rec-observability-item">
                    <span className="rec-observability-label">cache age</span>
                    <span className="rec-observability-value">{recCacheInfo.ageSec}s</span>
                  </div>
                </>
              )}
              {recTimingMs && (
                <>
                  <div className="rec-observability-item">
                    <span className="rec-observability-label">total</span>
                    <span className="rec-observability-value">{recTimingMs.total.toFixed(1)}ms</span>
                  </div>
                  <div className="rec-observability-item">
                    <span className="rec-observability-label">do fetch</span>
                    <span className="rec-observability-value">{recTimingMs.doFetch.toFixed(1)}ms</span>
                  </div>
                </>
              )}
              {recTrace && (
                <div className="rec-observability-item rec-observability-item--wide">
                  <span className="rec-observability-label">request id</span>
                  <span className="rec-observability-value rec-observability-mono">{recTrace.requestId}</span>
                </div>
              )}
            </div>
          </>
        )}

        {sourceEntries.length > 0 ? (
          <>
            <p className="rec-chart-title" style={{ marginTop: 16 }}>Source engagement</p>
            <div className="rec-source-legend">
              {ACTION_ORDER.filter(a => a !== 'seen').map(a => (
                <span key={a} className="rec-legend-item">
                  <span className="rec-legend-dot" style={{ background: ACTION_COLOR[a] }} />
                  {a}
                </span>
              ))}
            </div>
            <div className="rec-source-list">
              {sourceEntries.map(({ id, name, c, score }) => (
                <SourceRow key={id} name={name} c={c} score={score} maxScore={maxSource} />
              ))}
            </div>
          </>
        ) : data && (
          <p className="settings-hint" style={{ marginTop: 12 }}>
            No interaction data yet — read, save, or vote on articles to build your source profile.
          </p>
        )}

        {topicEntries.length > 0 && (
          <>
            <p className="rec-chart-title" style={{ marginTop: 16 }}>Topic affinity</p>
            <div className="rec-topic-list">
              {topicEntries.map(({ topic, score }) => (
                <TopicBar
                  key={topic}
                  label={TOPIC_META[topic as Topic]?.label ?? topic}
                  color={TOPIC_META[topic as Topic]?.color}
                  score={score}
                  maxScore={maxTopic}
                />
              ))}
            </div>
          </>
        )}

        {tagEntries.length > 0 && (
          <>
            <p className="rec-chart-title" style={{ marginTop: 16 }}>Tag affinity</p>
            <div className="rec-topic-list">
              {tagEntries.map(({ tag, score }) => (
                <TopicBar
                  key={tag}
                  label={tag}
                  score={score}
                  maxScore={maxTag}
                />
              ))}
            </div>
          </>
        )}

        {data?.debug && (
          <>
            <p className="rec-chart-title" style={{ marginTop: 16 }}>Model stats (worker)</p>
            <div className="rec-stat-grid">
              <div className="rec-stat-card">
                <div className="rec-stat-value">{data.debug.interactionsCount.count.toLocaleString()}</div>
                <div className="rec-stat-label">interactions</div>
              </div>
              <div className="rec-stat-card">
                <div className="rec-stat-value">{data.debug.userFactorsCount.count.toLocaleString()}</div>
                <div className="rec-stat-label">users</div>
              </div>
              <div className="rec-stat-card">
                <div className="rec-stat-value">{data.debug.itemFactorsCount.count.toLocaleString()}</div>
                <div className="rec-stat-label">items</div>
              </div>
              <div className="rec-stat-card">
                <div className="rec-stat-value">{data.debug.globalState.mean.toFixed(3)}</div>
                <div className="rec-stat-label">global mean</div>
              </div>
            </div>
            {data.debug.kvCounters && (
              <>
                <p className="rec-chart-title" style={{ marginTop: 12 }}>KV quota (isolate)</p>
                <div className="rec-stat-grid">
                  <div className="rec-stat-card">
                    <div className="rec-stat-value">{data.debug.kvCounters.reads.toLocaleString()}</div>
                    <div className="rec-stat-label">KV reads</div>
                  </div>
                  <div className="rec-stat-card">
                    <div className="rec-stat-value">{data.debug.kvCounters.writes.toLocaleString()}</div>
                    <div className="rec-stat-label">KV writes</div>
                  </div>
                  <div className="rec-stat-card">
                    <div className="rec-stat-value">{data.debug.kvCounters.memHits.toLocaleString()}</div>
                    <div className="rec-stat-label">mem hits</div>
                  </div>
                </div>
              </>
            )}
          </>
        )}

        {topRated.length > 0 ? (
          <>
            <p className="rec-chart-title" style={{ marginTop: 16 }}>Top collaborative scores</p>
            <p className="settings-hint" style={{ marginBottom: 4 }}>
              MF scores from your current feed pool. Feed tab shows per-card <strong>feed score</strong> (recency × diversity × boost).
              {titleLookupHint ? ` ${titleLookupHint}.` : ''}
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
                      <span className="rec-cf-score">score({entry.score.toFixed(2)})</span>
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
          <p className="settings-hint" style={{ marginTop: 16 }}>
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
