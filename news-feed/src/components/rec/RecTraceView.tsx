import { engagementScore, ACTION_WEIGHT, type ActionCounts } from '../../services/recStats';
import type { RecDebugInfo } from '../../services/recWorker';
import { TOPIC_META } from '../topicFilterUtils';
import type { Topic } from '../../types';

const MAX_SOURCE_ENTRIES = 12;
const MAX_TAG_ENTRIES = 12;

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

function counts(c: ActionCounts, action: Action): number {
  return (c as Record<string, number>)[action] ?? 0;
}

function SourceRow({ name, c, score, maxScore }: {
  name: string;
  c: ActionCounts;
  score: number;
  maxScore: number;
}) {
  // quality-ok: magic-number — percentage scale factor
  const barPct = maxScore > 0 ? Math.abs(score) / maxScore * 100 : 0;
  const isNeg  = score < 0;
  const chips  = ACTION_ORDER.filter(a => counts(c, a) > 0);

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
            {(() => {
              const positiveTotal = ACTION_ORDER.reduce((sum, action) => {
                const contribution = counts(c, action) * (ACTION_WEIGHT[action] ?? 0);
                return contribution > 0 ? sum + contribution : sum;
              }, 0);
              return ACTION_ORDER.map(action => {
                const n = counts(c, action);
                const weight = ACTION_WEIGHT[action] ?? 0;
                const contribution = n * weight;
                if (contribution <= 0) return null;
                // quality-ok: magic-number — percentage scale factor
                const segPct = positiveTotal > 0 ? contribution / positiveTotal * 100 : 0;
                return (
                  <div
                    key={action}
                    className="rec-source-segment"
                    style={{ width: `${segPct}%`, background: ACTION_COLOR[action] }}
                    title={`${action} ×${n} → +${contribution.toFixed(1)} pts`}
                  />
                );
              });
            })()}
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
  // quality-ok: magic-number — percentage scale factor
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

export interface SourceEntry {
  id: string;
  name: string;
  c: ActionCounts;
  score: number;
}

interface Props {
  sourceEntries: SourceEntry[];
  topicEntries: { topic: string; score: number }[];
  tagEntries: { tag: string; score: number }[];
  maxSource: number;
  maxTopic: number;
  maxTag: number;
  debug: RecDebugInfo | null;
  hasData: boolean;
}

export function RecTraceView({
  sourceEntries, topicEntries, tagEntries,
  maxSource, maxTopic, maxTag,
  debug, hasData,
}: Props) {
  return (
    <>
      {sourceEntries.length > 0 ? (
        <>
          {/* quality-ok: magic-number — CSS layout px value */}
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
      ) : hasData && (
        // quality-ok: magic-number — CSS layout px value
        <p className="settings-hint" style={{ marginTop: 12 }}>
          No interaction data yet — read, save, or vote on articles to build your source profile.
        </p>
      )}

      {topicEntries.length > 0 && (
        <>
          {/* quality-ok: magic-number — CSS layout px value */}
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
          {/* quality-ok: magic-number — CSS layout px value */}
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

      {debug && (
        <>
          {/* quality-ok: magic-number — CSS layout px value */}
          <p className="rec-chart-title" style={{ marginTop: 16 }}>Model stats (worker)</p>
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
          {debug.kvCounters && (
            <>
              {/* quality-ok: magic-number — CSS layout px value */}
              <p className="rec-chart-title" style={{ marginTop: 12 }}>KV quota (isolate)</p>
              <div className="rec-stat-grid">
                <div className="rec-stat-card">
                  <div className="rec-stat-value">{debug.kvCounters.reads.toLocaleString()}</div>
                  <div className="rec-stat-label">KV reads</div>
                </div>
                <div className="rec-stat-card">
                  <div className="rec-stat-value">{debug.kvCounters.writes.toLocaleString()}</div>
                  <div className="rec-stat-label">KV writes</div>
                </div>
                <div className="rec-stat-card">
                  <div className="rec-stat-value">{debug.kvCounters.memHits.toLocaleString()}</div>
                  <div className="rec-stat-label">mem hits</div>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}

export function buildSourceEntries(
  sources: Record<string, ActionCounts>,
  getSourceName: (id: string) => string,
): SourceEntry[] {
  return Object.entries(sources)
    .map(([id, c]) => ({ id, name: getSourceName(id), c, score: engagementScore(c) }))
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
    .slice(0, MAX_SOURCE_ENTRIES);
}

export function buildTopicEntries(
  topics: Record<string, ActionCounts>,
): { topic: string; score: number }[] {
  return Object.entries(topics)
    .map(([topic, c]) => ({ topic, score: engagementScore(c) }))
    .filter(e => e.score > 0)
    .sort((a, b) => b.score - a.score);
}

export function buildTagEntries(
  tags: Record<string, ActionCounts> | undefined,
): { tag: string; score: number }[] {
  return Object.entries(tags ?? {})
    .map(([tag, c]) => ({ tag, score: engagementScore(c) }))
    .filter(e => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_TAG_ENTRIES);
}
