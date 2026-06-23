import { useCallback, useEffect, useRef, useState } from 'react';
import { useCaptureToken } from '../../hooks/useCaptureToken';

const COPY_FEEDBACK_MS = 2_000;

export function CaptureSection() {
  const { captureToken, bookmarklet, hasRoom, busy, error, generate, revoke } = useCaptureToken();

  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  // React 19 sanitizes `javascript:` hrefs it renders, replacing them with a
  // throw. Set the bookmarklet href imperatively on the DOM node so the dragged
  // link carries the real bookmarklet.
  const bookmarkletRef = useRef<HTMLAnchorElement | null>(null);
  useEffect(() => {
    if (bookmarkletRef.current && bookmarklet) {
      bookmarkletRef.current.setAttribute('href', bookmarklet);
    }
  }, [bookmarklet]);

  const handleGenerate = useCallback(() => {
    void generate({ type: 'saved-list' });
  }, [generate]);

  const handleCopy = useCallback(async () => {
    if (!bookmarklet) return;
    try {
      await navigator.clipboard.writeText(bookmarklet);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    } catch {
      /* clipboard unavailable — the link is still draggable */
    }
  }, [bookmarklet]);

  return (
    <section className="settings-section">
      <h3>Capture from anywhere</h3>
      {!hasRoom ? (
        <p className="settings-hint">
          Set up <strong>Sync across devices</strong> above first. Capture attaches to your sync room.
        </p>
      ) : (
        <>
          <p className="settings-hint">
            Generate a bookmarklet and drag it to your bookmarks bar. Click it on any page to save
            it to your boomerang saved list.
          </p>

          <button
            type="button"
            className="btn-add-source"
            onClick={handleGenerate}
            disabled={busy}
          >
            {busy ? 'Working…' : captureToken ? 'Regenerate bookmarklet' : 'Generate bookmarklet'}
          </button>

          {error && <p className="sync-error" role="alert">{error}</p>}

          {captureToken && bookmarklet && (
            <>
              <div className="capture-bookmarklet-row">
                <a ref={bookmarkletRef} className="capture-bookmarklet" onClick={e => e.preventDefault()}>
                  📎 Save to boomerang
                </a>
                <button type="button" className="btn-add-source" onClick={handleCopy}>
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <button
                type="button"
                className="btn-reset-prefs"
                style={{ marginTop: '8px' }}
                onClick={() => void revoke()}
                disabled={busy}
              >
                Revoke capture token
              </button>
            </>
          )}
        </>
      )}
    </section>
  );
}
