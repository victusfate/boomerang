import type { RecResponseWithScores } from '../../services/recWorker';

interface Props {
  recModelDiagnostics: RecResponseWithScores['diagnostics'] | null;
  recCacheInfo: RecResponseWithScores['cache'] | null;
  recTimingMs: RecResponseWithScores['timingMs'] | null;
  recTrace: RecResponseWithScores['trace'] | null;
}

export function RecModelInfo({ recModelDiagnostics, recCacheInfo, recTimingMs, recTrace }: Props) {
  if (!recModelDiagnostics && !recCacheInfo && !recTimingMs && !recTrace) return null;
  return (
    <>
      {/* quality-ok: magic-number — CSS margin px value */}
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
  );
}
