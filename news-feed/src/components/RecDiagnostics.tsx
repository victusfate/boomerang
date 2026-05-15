import { useState, useCallback } from 'react';
import { loadRecStats, engagementScore, type ActionCounts } from '../services/recStats';
import { fetchRecDiagnostics, type RecDebugInfo } from '../services/recWorker';
import { resolveWorkerUrl } from '../config/workerEnv';
import { TOPIC_META } from './TopicFilter';
import type { RecStatus } from '../hooks/useRecWorker';
import type { Topic } from '../types';

const WORKER_BASE = resolveWorkerUrl(import.meta.env.VITE_REC_WORKER_URL);

const ACTION_ORDER = ['save', 'upvote', 'read', 'seen', 'downvote'] as const;
const ACTION_COLOR: Record<string, string> = {
  save:     '#6c63ff',
  upvote:   '#4caf50',
  read:     '#4a9eff',
  seen:     '#666',
  downvote: '#f44336',
};

interface Props {
  recArticleIds: string[];
  recStatus: RecStatus;
  getSourceName: (id: string) => string;
}

interface DiagData {
  stats: Awaited<ReturnType<typeof loadRecStats>>;
  debug: RecDebugInfo | null;
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rec-stat-card">
      <div className="rec-stat-value">{value}</div>
      <div className="rec-stat-label">{label}</div>
    </div>
  );
}

function ActionMiniBar({ counts }: { counts: ActionCounts }) {
  const total = ACTION_ORDER.reduce((s, a) => s + ((counts as Record<string, number>)[a] ?? 0), 0);
  if (total === 0) return <div className="rec-action-bar" />;
  return (
    <div className="rec-action-bar">
      {ACTION_ORDER.map(action => {
        const count = (counts as Record<string, number>)[action] ?? 0;
        if (!count) return null;
        return (
          <div
            key={action}
            className="rec-action-segment"
            style={{ width: `${(count / total) * 100}%`, background: ACTION_COLOR[action] }}
            title={`${action}: ${count}`}
          />
        );
      })}
    </div>
  );
}

function HBar({
  label, score, maxScore, fillColor, counts,
}: {
  label: string;
  score: number;
  maxScore: number;
  fillColor?: string;
  counts: ActionCounts;
}) {
  const pct = maxScore > 0 ? Math.max(0, (score / maxScore)) * 100 : 0;
  return (
    <div className="rec-hbar-row">
      <span className="rec-hbar-label" title={label}>{label}</span>
      <div className="rec-hbar-track">
        <div
          className="rec-hbar-fill"
          style={{ width: `${pct}%`, background: fillColor ?? 'var(--accent)' }}
        />
      </div>
      <ActionMiniBar counts={counts} />
      <span className="rec-hbar-score">{score.toFixed(1)}</span>
    </div>
  );
}

export function RecDiagnostics({ recArticleIds, recStatus, getSourceName }: Props) {
  const [data, setData] = useState<DiagData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  if (!data && !loading && !error) {
    return (
      <button type="button" className="btn-add-source" onClick={load}>
        Load rec diagnostics
      </button>
    );
  }
  if (loading) return <p className="settings-hint">Loading…</p>;
  if (error)   return <p className="sync-error">{error}</p>;

  const { stats, debug } = data!;

  const topicEntries = Object.entries(stats.topics)
    .map(([topic, counts]) => ({ topic, counts, score: engagementScore(counts) }))
    .filter(e => e.score !== 0)
    .sort((a, b) => b.score - a.score);

  const sourceEntries = Object.entries(stats.sources)
    .map(([id, counts]) => ({ id, name: getSourceName(id), counts, score: engagementScore(counts) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  const maxTopic  = topicEntries[0]?.score  || 1;
  const maxSource = sourceEntries[0]?.score || 1;

  const statusDot = recStatus === 'active' ? 'active' : recStatus === 'error' ? 'error' : 'idle';

  return (
    <div className="rec-diag">
      <button type="button" className="rec-diag-reload" onClick={load} title="Refresh diagnostics">↺</button>

      {/* Model health cards */}
      {debug && (
        <div className="rec-stat-grid">
          <StatCard label="interactions" value={debug.interactionsCount.count.toLocaleString()} />
          <StatCard label="users modeled" value={debug.userFactorsCount.count.toLocaleString()} />
          <StatCard label="items modeled" value={debug.itemFactorsCount.count.toLocaleString()} />
          <StatCard label="global mean" value={debug.globalState.mean.toFixed(3)} />
        </div>
      )}

      {/* Engine status + local totals */}
      <div className="rec-status-row">
        <span className={`sync-dot sync-dot--${statusDot}`} />
        <span className="settings-hint" style={{ margin: 0 }}>
          {recArticleIds.length > 0
            ? `${recArticleIds.length} articles ranked`
            : recStatus === 'active'
              ? 'Cold start — needs more interactions'
              : 'Engine offline'}
        </span>
        <span className="rec-status-sep" />
        <span className="settings-hint" style={{ margin: 0 }}>
          {stats.total.toLocaleString()} local interactions
        </span>
      </div>

      {/* Topic affinity */}
      {topicEntries.length > 0 && (
        <>
          <p className="rec-chart-title">Topic affinity</p>
          <div className="rec-chart">
            {topicEntries.map(({ topic, counts, score }) => (
              <HBar
                key={topic}
                label={TOPIC_META[topic as Topic]?.label ?? topic}
                score={score}
                maxScore={maxTopic}
                fillColor={TOPIC_META[topic as Topic]?.color}
                counts={counts}
              />
            ))}
          </div>
        </>
      )}

      {/* Source engagement */}
      {sourceEntries.length > 0 && (
        <>
          <p className="rec-chart-title">Source engagement</p>
          <div className="rec-chart">
            {sourceEntries.map(({ id, name, counts, score }) => (
              <HBar
                key={id}
                label={name}
                score={score}
                maxScore={maxSource}
                counts={counts}
              />
            ))}
          </div>
        </>
      )}

      {/* Action legend */}
      {(topicEntries.length > 0 || sourceEntries.length > 0) && (
        <div className="rec-legend">
          {ACTION_ORDER.map(a => (
            <span key={a} className="rec-legend-item">
              <span className="rec-legend-dot" style={{ background: ACTION_COLOR[a] }} />
              {a}
            </span>
          ))}
        </div>
      )}

      {topicEntries.length === 0 && sourceEntries.length === 0 && (
        <p className="settings-hint">
          No local interaction data yet — read, save, or vote on articles to build your engagement profile.
        </p>
      )}
    </div>
  );
}
