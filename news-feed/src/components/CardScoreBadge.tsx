import type { FeedScoreInsight } from '../services/feedScoreBreakdown';

interface Props {
  insight: FeedScoreInsight | null;
  /** Rec worker enabled but scores not ready yet */
  loading?: boolean;
}

function fmt(n: number, digits = 3): string {
  return n.toFixed(digits);
}

export function CardScoreBadge({ insight, loading = false }: Props) {
  if (loading) {
    return (
      <span className="card-score-badge card-score-badge--pending" title="Loading recommendation scores…">
        rec…
      </span>
    );
  }

  if (!insight) return null;

  const { mfScore, recBoost, composite, inRecList, tierMultiplier } = insight;
  const chipLabel = mfScore !== null
    ? `s${fmt(mfScore, 2)}`
    : inRecList
      ? `×${fmt(recBoost, 2)}`
      : `L${fmt(composite, 2)}`;

  const chipTitle = mfScore !== null
    ? `Collaborative score ${fmt(mfScore)} — hover for breakdown`
    : inRecList
      ? `Feed boost ×${fmt(recBoost)} — hover for breakdown`
      : `Local rank ${fmt(composite)} — hover for breakdown`;

  return (
    <span className="card-score-hover">
      <span className="card-score-badge" title={chipTitle}>
        {chipLabel}
      </span>
      <div className="card-score-popover" role="tooltip">
        <p className="card-score-popover-title">Feed ranking</p>
        <dl className="card-score-dl">
          <div className="card-score-row">
            <dt>MF score</dt>
            <dd>{mfScore !== null ? fmt(mfScore) : '—'}</dd>
          </div>
          <div className="card-score-row">
            <dt>Rec list</dt>
            <dd>{insight.recListRank !== null ? `#${insight.recListRank}` : 'outside pool'}</dd>
          </div>
          <div className="card-score-row">
            <dt>Feed boost</dt>
            <dd>×{fmt(recBoost, 2)}</dd>
          </div>
          <div className="card-score-row">
            <dt>Recency</dt>
            <dd>{fmt(insight.recency)}</dd>
          </div>
          <div className="card-score-row">
            <dt>Diversity</dt>
            <dd>{fmt(insight.diversity)}</dd>
          </div>
          <div className="card-score-row">
            <dt>Tier</dt>
            <dd>
              {insight.fetchTier}
              {tierMultiplier < 1 ? ` (×${tierMultiplier})` : ''}
            </dd>
          </div>
          <div className="card-score-row card-score-row--total">
            <dt>Composite</dt>
            <dd>{fmt(composite)}</dd>
          </div>
        </dl>
        <p className="card-score-popover-hint">
          Composite ≈ recency × diversity × feed boost
          {tierMultiplier < 1 ? ' × tier' : ''}. MF learns from reads, saves, and votes.
        </p>
      </div>
    </span>
  );
}
