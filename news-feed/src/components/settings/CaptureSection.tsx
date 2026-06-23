import { useCallback, useRef, useState } from 'react';
import { useCaptureToken } from '../../hooks/useCaptureToken';
import type { CaptureDestination } from '../../services/captureWorker';

const COPY_FEEDBACK_MS = 2_000;

type DestinationType = CaptureDestination['type'];

export function CaptureSection() {
  const { captureToken, destination, bookmarklet, hasRoom, busy, error, generate, revoke } = useCaptureToken();

  const [destType, setDestType] = useState<DestinationType>(destination?.type ?? 'saved-list');
  const [github, setGithub] = useState(
    destination?.type === 'github'
      ? destination
      : { owner: '', repo: '', path: 'reading.md', branch: 'main' },
  );
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  const handleGenerate = useCallback(() => {
    const dest: CaptureDestination =
      destType === 'github'
        ? { type: 'github', owner: github.owner.trim(), repo: github.repo.trim(), path: github.path.trim(), branch: github.branch.trim() }
        : { type: 'saved-list' };
    void generate(dest);
  }, [destType, github, generate]);

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

  const githubIncomplete = destType === 'github' && (!github.owner.trim() || !github.repo.trim() || !github.path.trim());

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
            Pick where captured pages go, generate a bookmarklet, then drag it to your bookmarks bar.
            Click it on any page to save it.
          </p>

          <div className="capture-dest-row">
            <label>
              <input
                type="radio"
                name="capture-dest"
                checked={destType === 'saved-list'}
                onChange={() => setDestType('saved-list')}
              />{' '}
              My boomerang saved list
            </label>
            <label>
              <input
                type="radio"
                name="capture-dest"
                checked={destType === 'github'}
                onChange={() => setDestType('github')}
              />{' '}
              A GitHub Markdown file
            </label>
          </div>

          {destType === 'github' && (
            <div className="capture-github-fields">
              <input className="custom-source-input" placeholder="owner" value={github.owner}
                onChange={e => setGithub({ ...github, owner: e.target.value })} />
              <input className="custom-source-input" placeholder="repo" value={github.repo}
                onChange={e => setGithub({ ...github, repo: e.target.value })} />
              <input className="custom-source-input" placeholder="path (e.g. reading.md)" value={github.path}
                onChange={e => setGithub({ ...github, path: e.target.value })} />
              <input className="custom-source-input" placeholder="branch" value={github.branch}
                onChange={e => setGithub({ ...github, branch: e.target.value })} />
            </div>
          )}

          <button
            type="button"
            className="btn-add-source"
            onClick={handleGenerate}
            disabled={busy || githubIncomplete}
          >
            {busy ? 'Working…' : captureToken ? 'Regenerate bookmarklet' : 'Generate bookmarklet'}
          </button>

          {error && <p className="sync-error" role="alert">{error}</p>}

          {captureToken && bookmarklet && (
            <>
              <div className="capture-bookmarklet-row">
                <a className="capture-bookmarklet" href={bookmarklet} onClick={e => e.preventDefault()}>
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
