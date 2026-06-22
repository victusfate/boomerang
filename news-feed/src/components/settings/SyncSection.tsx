import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

const COPY_FEEDBACK_MS = 2_000;
const QR_CODE_WIDTH    = 200;
import type { MetaStatus } from '../../hooks/useMetaWorker';
import type { SyncErrorDetails } from '../../hooks/useSyncWorker';
import { timeAgo } from '../../services/timeAgo';

interface Props {
  syncActive: boolean;
  syncStatus: 'idle' | 'active' | 'syncing' | 'error';
  syncedAt: Date | null;
  syncError: string | null;
  syncErrorDetails: SyncErrorDetails | null;
  syncUrl: string | null;
  syncEnvError: string | null;
  metaStatus: MetaStatus;
  metaError: string | null;
  metaEnvError: string | null;
  onForceMetaSync: () => Promise<void>;
  onForceSync: () => Promise<void>;
  onGenerateLink: () => Promise<void>;
  onRevoke: () => Promise<void>;
}

function SyncErrorDetailsBlock({ details, marginTop }: { details: SyncErrorDetails | null; marginTop: string }) {
  if (!details) return null;
  return (
    <details className="settings-hint" style={{ marginTop }}>
      <summary>Show technical sync details</summary>
      <code>
        phase={details.phase}
        {' | '}roomId={details.roomId ?? 'n/a'}
        {' | '}worker={details.workerUrl ?? 'n/a'}
        {details.endpoint ? ` | endpoint=${details.endpoint}` : ''}
      </code>
    </details>
  );
}

export function SyncSection({
  syncActive, syncStatus, syncedAt, syncError, syncErrorDetails, syncUrl, syncEnvError,
  metaStatus, metaError, metaEnvError,
  onForceMetaSync, onForceSync, onGenerateLink, onRevoke,
}: Props) {
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [copied, setCopied]       = useState(false);
  const statusTimersRef = useRef<number[]>([]);

  useEffect(() => () => {
    for (const id of statusTimersRef.current) clearTimeout(id);
  }, []);

  useEffect(() => {
    if (!syncUrl) { setQrDataUrl(''); return; }
    QRCode.toDataURL(syncUrl, { width: QR_CODE_WIDTH, margin: 2 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(''));
  }, [syncUrl]);

  const handleCopyShareUrl = useCallback(async () => {
    if (!syncUrl) return;
    try {
      await navigator.clipboard.writeText(syncUrl);
      setCopied(true);
      statusTimersRef.current.push(window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS));
    } catch {
      // fallback: select the text
    }
  }, [syncUrl]);

  return (
    <>
      <section className="settings-section">
        <h3>Shared metadata</h3>
        <p className="settings-hint">
          Shared tags sync manually. Tap <strong>Sync shared tags now</strong> or use the main refresh action.
        </p>
        {metaEnvError ? (
          <p className="sync-error" role="alert">{metaEnvError}</p>
        ) : (
          <>
            <div className="sync-status-row">
              <span className={`sync-dot sync-dot--${metaStatus === 'disabled' ? 'idle' : metaStatus}`} />
              <span className="sync-status-label">
                {metaStatus === 'syncing' && 'Updating shared tags…'}
                {metaStatus === 'active' && 'Shared tags active'}
                {metaStatus === 'error' && 'Shared tags offline'}
                {metaStatus === 'disabled' && 'Shared tags disabled'}
              </span>
            </div>
            <button
              type="button"
              className="btn-add-source"
              onClick={() => void onForceMetaSync()}
              disabled={metaStatus === 'syncing'}
            >
              {metaStatus === 'syncing' ? 'Syncing tags…' : 'Sync shared tags now'}
            </button>
            {metaError && <p className="sync-error">{metaError}</p>}
          </>
        )}
      </section>

      <section className="settings-section">
        <h3>Sync across devices</h3>
        {!syncActive && syncEnvError && (
          <p className="sync-error" role="alert">{syncEnvError}</p>
        )}
        {!syncActive ? (
          <>
            <p className="settings-hint">
              Generate a link and open it on another device. Both devices will stay in sync — no account needed.
            </p>
            <button
              type="button"
              className="btn-add-source"
              onClick={() => void onGenerateLink()}
              disabled={syncStatus === 'syncing'}
            >
              {syncStatus === 'syncing' ? 'Generating…' : 'Generate sync link'}
            </button>
            {syncError && (
              <>
                <p className="sync-error">{syncError}</p>
                <SyncErrorDetailsBlock details={syncErrorDetails} marginTop="6px" />
              </>
            )}
          </>
        ) : (
          <>
            <p className="settings-hint">
              Sync is manual. Tap <strong>Sync now</strong> or use the main refresh action to pull and push updates.
            </p>
            <div className="sync-status-row">
              <span className={`sync-dot sync-dot--${syncStatus}`} />
              <span className="sync-status-label">
                {syncStatus === 'syncing' && 'Syncing…'}
                {syncStatus === 'active' && syncedAt && `Synced ${timeAgo(syncedAt, 'ago')}`}
                {syncStatus === 'active' && !syncedAt && 'Active'}
                {syncStatus === 'error' && `Error: ${syncError}`}
              </span>
            </div>
            {qrDataUrl && (
              <div className="sync-qr-wrap">
                <img src={qrDataUrl} alt="QR code for device sync" className="sync-qr" />
              </div>
            )}
            <button
              type="button"
              className="btn-add-source"
              onClick={() => void onForceSync()}
              disabled={syncStatus === 'syncing'}
            >
              {syncStatus === 'syncing' ? 'Syncing…' : 'Sync now'}
            </button>
            {syncUrl && (
              <div className="sync-url-row">
                <input
                  type="text"
                  className="custom-source-input sync-url-input"
                  readOnly
                  value={syncUrl}
                  onFocus={e => (e.target as HTMLInputElement).select()}
                />
                <button type="button" className="btn-add-source" onClick={handleCopyShareUrl}>
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
            )}
            <button
              type="button"
              className="btn-reset-prefs"
              style={{ marginTop: '8px' }}
              onClick={() => void onRevoke()}
            >
              Revoke sync
            </button>
            <SyncErrorDetailsBlock details={syncErrorDetails} marginTop="8px" />
          </>
        )}
      </section>
    </>
  );
}
