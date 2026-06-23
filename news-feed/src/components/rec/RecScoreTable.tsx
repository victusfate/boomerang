import { articleCatalogMissingTitleLabel } from '../../../../shared/articleRecordCatalog.ts';
import type { RecStatus } from '../../hooks/useRecWorker';

const SCORE_EPSILON = 1e-9;

interface RankedEntry {
  id: string;
  rank: number;
  score: number;
}

interface Props {
  topRated: RankedEntry[];
  minScore: number;
  maxScore: number;
  scoreSpan: number;
  getArticleTitle: (id: string) => string | null;
  lookupTitleById: Record<string, string>;
  titleLookupHint: string | null;
  recStatus: RecStatus;
}

export function RecScoreTable({
  topRated, minScore, scoreSpan,
  getArticleTitle, lookupTitleById, titleLookupHint, recStatus,
}: Props) {
  if (topRated.length === 0) {
    return (
      <p className="settings-hint" style={{ marginTop: 16 }}>
        {recStatus === 'error'
          ? 'Could not load rankings — check the worker and try refreshing the feed.'
          : recStatus === 'disabled'
            ? 'Recommendations are disabled (missing worker URL).'
            : 'No scores yet. Load the feed and interact with articles to train the model.'}
      </p>
    );
  }

  return (
    <>
      {/* quality-ok: magic-number — CSS margin px value */}
      <p className="rec-chart-title" style={{ marginTop: 16 }}>Top collaborative scores</p>
      {/* quality-ok: magic-number — CSS margin px value */}
      <p className="settings-hint" style={{ marginBottom: 4 }}>
        MF scores from your current feed pool. Feed tab shows per-card <strong>feed score</strong> (recency × diversity × boost).
        {titleLookupHint ? ` ${titleLookupHint}.` : ''}
      </p>
      <div className="rec-cf-list">
        {topRated.map(entry => {
          // quality-ok: magic-number — percentage scale factor
          const pct = scoreSpan <= SCORE_EPSILON ? 100 : ((entry.score - minScore) / scoreSpan) * 100;
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
  );
}
