import { useCallback, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FeedScoreInsight } from '../services/feedScoreBreakdown';

interface Props {
  insight: FeedScoreInsight | null;
  /** Rec worker enabled but scores not ready yet */
  loading?: boolean;
}

function fmt(n: number, digits = 3): string {
  return n.toFixed(digits);
}

function ScorePopoverBody({ insight }: { insight: FeedScoreInsight }) {
  const { mfScore, recBoost, composite, tierMultiplier } = insight;

  return (
    <>
      <p className="card-score-popover-title">Feed ranking</p>
      <dl className="card-score-dl">
        <div className="card-score-row card-score-row--total">
          <dt>Feed score</dt>
          <dd>{fmt(composite)}</dd>
        </div>
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
      </dl>
      <p className="card-score-popover-hint">
        Feed score ≈ recency × diversity × feed boost
        {tierMultiplier < 1 ? ' × tier' : ''}. MF learns from reads, saves, and votes.
      </p>
    </>
  );
}

export function CardScoreBadge({ insight, loading = false }: Props) {
  const [open, setOpen] = useState(false);
  const popoverId = useId();
  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);

  if (loading) {
    return (
      <span className="card-score-badge card-score-badge--pending" title="Loading recommendation scores…">
        score(…)
      </span>
    );
  }

  if (!insight) return null;

  const { mfScore, composite } = insight;
  const chipLabel = `score(${fmt(composite, 2)})`;

  const chipTitle = mfScore !== null
    ? `Feed sort score ${fmt(composite)} (MF ${fmt(mfScore)}) — hover for breakdown`
    : `Feed sort score ${fmt(composite)} — hover for breakdown`;

  return (
    <>
      <span
        className="card-score-hover"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        <span
          className="card-score-badge"
          title={chipTitle}
          tabIndex={0}
          role="button"
          aria-expanded={open}
          aria-describedby={open ? popoverId : undefined}
        >
          {chipLabel}
        </span>
      </span>
      {open && createPortal(
        <div
          id={popoverId}
          className="card-score-popover card-score-popover--centered"
          role="tooltip"
        >
          <ScorePopoverBody insight={insight} />
        </div>,
        document.body,
      )}
    </>
  );
}
