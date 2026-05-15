import { useState, useCallback, useEffect } from 'react';
import { loadRecStats, engagementScore, ACTION_WEIGHT, type ActionCounts } from '../services/recStats';
import { fetchRecDiagnostics, type RecDebugInfo } from '../services/recWorker';
import { resolveWorkerUrl } from '../config/workerEnv';
import { TOPIC_META } from './TopicFilter';
import type { RecStatus } from '../hooks/useRecWorker';
import type { Topic } from '../types';

const WORKER_BASE = resolveWorkerUrl(import.meta.env.VITE_REC_WORKER_URL);

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
  recArticleIds: string[];
  recGeneratedAt: number | null;
  recStatus: RecStatus;
  getSourceName: (id: string) => string;
  autoLoad?: boolean;
}

interface DiagData {
  stats: Awaited<ReturnType<typeof loadRecStats>>;
  debug: RecDebugInfo | null;
}

function counts(c: ActionCounts, action: Action): number {
  return (c as Record<string, number>)[action] ?? 0;
}

function cfBoostAtRank(index: number, total: number): number {
  if (total <= 1) return 1.8;
  const rank01 = index / Math.max(total - 1, 1);
  return 1.0 + (1.0 - rank01) * 0.8;
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

// Source row: stacked bar where each segment width = action's contribution to score
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

      {/* Stacked bar: segments proportional to each action's weighted contribution */}
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

      {/* Count chips */}
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

// Compact topic bar (secondary section)
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

export function RecDiagnostics({ recArticleIds, recGeneratedAt, recStatus, getSourceName, autoLoad }: Props) {
  const [data, setData]       = useState<DiagData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [stats, debug] = await Promise.all([
        loadRecStats(),
        WORKER_BASE
          ? fetchRecDiagnostics(WORKER_BASE).catch(() => null)
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
    if (autoLoad) void load();
  }, [autoLoad, load]);

  if (!data && !loading && !error) {
    return (
      <button type="button" className="btn-add-source" onClick={load}>
        Load diagnostics
      </button>
    );
  }
  if (loading) return <p className="settings-hint">Loading…</p>;
  if (error)   return <p className="sync-error">{error}</p>;

  const { stats, debug } = data!;

  const sourceEntries = Object.entries(stats.sources)
    .map(([id, c]) => ({ id, name: getSourceName(id), c, score: engagementScore(c) }))
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
    .slice(0, 12);

  const topicEntries = Object.entries(stats.topics)
    .map(([topic, c]) => ({ topic, score: engagementScore(c) }))
    .filter(e => e.score > 0)
    .sort((a, b) => b.score - a.score);

  const tagEntries = Object.entries(stats.tags ?? {})
    .map(([tag, c]) => ({ tag, score: engagementScore(c) }))
    .filter(e => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);

  const maxSource = sourceEntries[0] ? Math.abs(sourceEntries[0].score) : 1;
  const maxTopic  = topicEntries[0]?.score || 1;
  const maxTag    = tagEntries[0]?.score   || 1;
  const recPreview = recArticleIds.slice(0, 12).map((id, idx) => {
    const boost = cfBoostAtRank(idx, recArticleIds.length);
    return {
      id,
      rank: idx + 1,
      boost,
      // 1.0x..1.8x maps to 0..100%
      pct: ((boost - 1.0) / 0.8) * 100,
    };
  });

  const statusDot = recStatus === 'active' ? 'active' : recStatus === 'error' ? 'error' : 'idle';

  return (
    <div className="rec-diag">
      {/* Status bar */}
      <div className="rec-status-row">
        <span className={`sync-dot sync-dot--${statusDot}`} />
        <span className="settings-hint" style={{ margin: 0 }}>
          {stats.total.toLocaleString()} local interactions
        </span>
        <span className="rec-status-sep" />
        <span className="settings-hint" style={{ margin: 0 }}>
          {recArticleIds.length > 0
            ? `${recArticleIds.length} articles ranked`
            : recStatus === 'active' ? 'cold start' : 'offline'}
        </span>
        <button type="button" className="rec-diag-reload" onClick={load} title="Refresh">↺</button>
      </div>

      <p className="rec-chart-title">Collaborative ranking influence</p>
      {recPreview.length > 0 ? (
        <>
          <p className="settings-hint" style={{ marginBottom: 4 }}>
            Worker snapshot {formatModelAge(recGeneratedAt)}. Higher-ranked ids get more feed influence (up to 1.8x).
          </p>
          <div className="rec-cf-list">
            {recPreview.map(entry => (
              <div key={entry.id} className="rec-cf-row">
                <div className="rec-cf-header">
                  <span className="rec-cf-rank">#{entry.rank}</span>
                  <span className="rec-cf-id" title={entry.id}>{entry.id}</span>
                  <span className="rec-cf-boost">x{entry.boost.toFixed(2)}</span>
                </div>
                <div className="rec-cf-track">
                  <div className="rec-cf-fill" style={{ width: `${entry.pct}%` }} />
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="settings-hint">
          No collaborative ranking ids yet (cold start or offline).
        </p>
      )}

      {/* Source engagement — primary focus */}
      {sourceEntries.length > 0 ? (
        <>
          <p className="rec-chart-title">Source engagement</p>
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
      ) : (
        <p className="settings-hint">
          No interaction data yet — read, save, or vote on articles to build your source profile.
        </p>
      )}

      {/* Topic affinity — secondary */}
      {topicEntries.length > 0 && (
        <>
          <p className="rec-chart-title" style={{ marginTop: 4 }}>Topic affinity</p>
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

      {/* Tag engagement — shown when AI/manual/shared tags have been accumulated */}
      {tagEntries.length > 0 && (
        <>
          <p className="rec-chart-title" style={{ marginTop: 4 }}>Tag engagement</p>
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

      {/* Model stats — always visible */}
      {debug && (
        <>
          <p className="rec-chart-title" style={{ marginTop: 4 }}>Model stats</p>
          <div className="rec-stat-grid">
            <div className="rec-stat-card">
              <div className="rec-stat-value">{debug.interactionsCount.count.toLocaleString()}</div>
              <div className="rec-stat-label">interactions</div>
            </div>
            <div className="rec-stat-card">
              <div className="rec-stat-value">{debug.userFactorsCount.count.toLocaleString()}</div>
              <div className="rec-stat-label">users</div>
            </div>
            <div className="rec-stat-card">
              <div className="rec-stat-value">{debug.itemFactorsCount.count.toLocaleString()}</div>
              <div className="rec-stat-label">items</div>
            </div>
            <div className="rec-stat-card">
              <div className="rec-stat-value">{debug.globalState.mean.toFixed(3)}</div>
              <div className="rec-stat-label">global mean</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
