import { useEffect, useRef, useState } from 'react';
import { DEFAULT_SOURCES } from '../services/newsService';
import { isSourceEnabled, isTopicEnabled } from '../services/storage';
import type { CustomSource, Topic, UserPrefs } from '../types';
import { TOPIC_META } from './TopicFilter';

const ALL_TOPICS = (Object.keys(TOPIC_META) as Topic[]).filter(t => t !== 'general');

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

interface Props {
  prefs: UserPrefs;
  onToggleSource: (id: string) => void;
  onToggleTopic: (topic: Topic) => void;
  onResetPrefs: () => void;
  onClearViewed: () => void;
  onClose: () => void;
  onAddCustomSource: (source: CustomSource) => void;
  onRemoveCustomSource: (id: string) => void;
  onExportBookmark: () => string;
  onImportBookmark: (encoded: string) => boolean;
}

export function Settings({
  prefs, onToggleSource, onToggleTopic, onResetPrefs, onClearViewed, onClose,
  onAddCustomSource, onRemoveCustomSource, onExportBookmark, onImportBookmark,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<Element | null>(null);

  // Custom source form
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl]   = useState('');

  // Bookmark
  const [bookmarkCopied, setBookmarkCopied] = useState(false);
  const [importValue, setImportValue]       = useState('');
  const [importStatus, setImportStatus]     = useState<'idle' | 'ok' | 'error'>('idle');

  useEffect(() => {
    previousFocusRef.current = document.activeElement;
    panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'Tab' && panelRef.current) {
        const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last  = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      (previousFocusRef.current as HTMLElement | null)?.focus();
    };
  }, [onClose]);

  const handleAddSource = (e: React.FormEvent) => {
    e.preventDefault();
    const name    = newName.trim();
    const feedUrl = newUrl.trim();
    if (!name || !feedUrl) return;
    const id = Date.now().toString(36);
    onAddCustomSource({ id, name, feedUrl });
    setNewName('');
    setNewUrl('');
  };

  const handleCopyBookmark = async () => {
    const url = onExportBookmark();
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Fallback: select the text in the hidden field
      const el = document.createElement('textarea');
      el.value = url;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    setBookmarkCopied(true);
    setTimeout(() => setBookmarkCopied(false), 2500);
  };

  const handleImport = () => {
    const ok = onImportBookmark(importValue);
    setImportStatus(ok ? 'ok' : 'error');
    if (ok) { setImportValue(''); setTimeout(() => setImportStatus('idle'), 3000); }
  };

  return (
    <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="settings-panel" ref={panelRef}>
        <div className="settings-header">
          <h2>Customize Feed</h2>
          <button className="btn-close" onClick={onClose} aria-label="Close settings">✕</button>
        </div>

        <section className="settings-section">
          <h3>Topics</h3>
          <p className="settings-hint">Articles you read boost topic weight automatically.</p>
          <div className="settings-grid">
            {ALL_TOPICS.map(topic => {
              const meta    = TOPIC_META[topic];
              const enabled = isTopicEnabled(topic, prefs);
              const weight  = prefs.topicWeights[topic] ?? 1.0;
              return (
                <button
                  key={topic}
                  className={`setting-toggle ${enabled ? 'on' : 'off'}`}
                  onClick={() => onToggleTopic(topic)}
                  style={{ '--toggle-color': meta.color } as React.CSSProperties}
                >
                  <span className="toggle-label">{meta.label}</span>
                  {weight > 1.2 && (
                    <span className="toggle-boost" title={`Boost: ${weight.toFixed(1)}×`}>
                      {weight > 2 ? '↑↑' : '↑'}
                    </span>
                  )}
                  <span className={`toggle-indicator ${enabled ? 'on' : ''}`} />
                </button>
              );
            })}
          </div>
        </section>

        <section className="settings-section">
          <h3>Sources</h3>
          <div className="source-list">
            {DEFAULT_SOURCES.map(source => {
              const enabled = isSourceEnabled(source.id, prefs);
              const meta    = TOPIC_META[source.category];
              return (
                <button
                  key={source.id}
                  className={`source-item ${enabled ? 'on' : 'off'}`}
                  onClick={() => onToggleSource(source.id)}
                >
                  <span className="source-dot" style={{ background: meta?.color ?? '#888' }} />
                  <span className="source-name">{source.name}</span>
                  <span className="source-cat">{meta?.label}</span>
                  <span className={`toggle-indicator ${enabled ? 'on' : ''}`} />
                </button>
              );
            })}
          </div>
        </section>

        {/* ── Custom Sources ─────────────────────────────────────────────── */}
        <section className="settings-section">
          <h3>Custom Sources</h3>
          <p className="settings-hint">Add any RSS or Atom feed URL. Fetched via the worker — no CORS issues.</p>

          {prefs.customSources.length > 0 && (
            <ul className="custom-source-list">
              {prefs.customSources.map(src => (
                <li key={src.id} className="custom-source-item">
                  <div className="custom-source-info">
                    <span className="custom-source-name">{src.name}</span>
                    <span className="custom-source-url">{src.feedUrl}</span>
                  </div>
                  <button
                    className="btn-remove-source"
                    onClick={() => onRemoveCustomSource(src.id)}
                    aria-label={`Remove ${src.name}`}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}

          <form className="custom-source-form" onSubmit={handleAddSource}>
            <input
              type="text"
              className="custom-source-input"
              placeholder="Source name"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              required
            />
            <input
              type="url"
              className="custom-source-input"
              placeholder="https://example.com/feed.rss"
              value={newUrl}
              onChange={e => setNewUrl(e.target.value)}
              required
            />
            <button type="submit" className="btn-add-source">Add</button>
          </form>
        </section>

        {/* ── Bookmark ───────────────────────────────────────────────────── */}
        <section className="settings-section settings-section-bookmark">
          <h3>Backup &amp; Restore</h3>
          <p className="settings-hint">
            Copies a long URL to your clipboard. It includes preferences, custom feeds, and your
            <strong>saved articles</strong> (so starred items show up in a new browser or private window,
            not just the IDs). Use a fresh export after adding saves.
          </p>
          <div className="settings-field">
            <span className="settings-label" id="bookmark-export-label">Export</span>
            <button
              type="button"
              className="btn-bookmark"
              onClick={handleCopyBookmark}
              aria-labelledby="bookmark-export-label"
            >
              {bookmarkCopied ? 'Copied to clipboard' : 'Copy backup URL'}
            </button>
          </div>

          <div className="settings-field settings-field-import">
            <label className="settings-label" htmlFor="bookmark-import-input">Import</label>
            <p className="settings-hint settings-hint-tight">
              Paste the full URL from <strong>Copy backup URL</strong>, or paste only the base64 part after{' '}
              <code className="settings-code">#bm=</code>.
            </p>
            <textarea
              id="bookmark-import-input"
              className="settings-textarea"
              placeholder="https://…/boomerang/#bm=…  or paste the base64 payload only"
              rows={4}
              autoComplete="off"
              spellCheck={false}
              value={importValue}
              onChange={e => { setImportValue(e.target.value); setImportStatus('idle'); }}
            />
            <button
              type="button"
              className="btn-add-source btn-import-apply"
              onClick={handleImport}
              disabled={!importValue.trim()}
            >
              Apply import
            </button>
          </div>
          {importStatus === 'ok'    && <p className="import-status ok">Imported — preferences applied and feed refreshing.</p>}
          {importStatus === 'error' && <p className="import-status error">Could not read that bookmark — paste the full URL or the base64 block and try again.</p>}
        </section>

        <section className="settings-section">
          <h3>Preferences</h3>
          <p className="settings-hint">Clear viewed history to see previously read articles again.</p>
          <button className="btn-reset-prefs" onClick={() => { onClearViewed(); onClose(); }}>
            Clear viewed history
          </button>
          <p className="settings-hint" style={{ marginTop: '12px' }}>
            Reset all learned weights from votes and reading history. Source and topic toggles are preserved.
          </p>
          <button className="btn-reset-prefs" onClick={() => { onResetPrefs(); onClose(); }}>
            Reset learned preferences
          </button>
        </section>

        <section className="settings-section">
          <h3>About</h3>
          <p className="settings-about">
            Boomerang News is an ad-free algorithmic news aggregator.
            Articles open in your default browser or native apps.
            All preferences are stored locally on your device — no account needed.
          </p>
          <p className="settings-about">
            <strong>Android setup:</strong> Install this as a PWA from your browser menu
            ("Add to Home Screen"), then configure your launcher to open it when swiping left.
          </p>
        </section>
      </div>
    </div>
  );
}
