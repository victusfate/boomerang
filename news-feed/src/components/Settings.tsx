import { useEffect, useRef, useState, useCallback } from 'react';
import QRCode from 'qrcode';
import { DEFAULT_SOURCES } from '../services/newsService';
import { isSourceEnabled, isTopicEnabled } from '../services/storage';
import { isPromptApiAvailable } from '../services/labelClassifier';
import type { Article, CustomSource, Topic, UserLabel, UserPrefs } from '../types';
import type { MetaStatus } from '../hooks/useMetaWorker';
import { TOPIC_META } from './TopicFilter';

const ALL_TOPICS = (Object.keys(TOPIC_META) as Topic[]).filter(t => t !== 'general');

function formatSyncedAt(d: Date): string {
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  return mins < 1 ? 'just now' : `${mins}m ago`;
}

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
  onExportOPML: () => void;
  onImportOPML: (xml: string) => boolean;
  onExportBookmarks: () => void;
  onImportBookmarks: (html: string) => boolean;
  onAddLabel: (label: UserLabel) => void;
  onDeleteLabel: (labelId: string) => void;
  onSuggestLabels: (articles: Article[]) => Promise<string[]>;
  // Live sync
  syncActive: boolean;
  syncStatus: 'idle' | 'active' | 'syncing' | 'error';
  syncedAt: Date | null;
  syncError: string | null;
  syncUrl: string | null;
  syncEnvError: string | null;
  // Shared article metadata
  metaStatus: MetaStatus;
  metaError: string | null;
  metaEnvError: string | null;
  onForceMetaSync: () => Promise<void>;
  onForceSync: () => Promise<void>;
  onGenerateLink: () => Promise<void>;
  onRevoke: () => Promise<void>;
  onToggleAiBar: () => void;
}

export function Settings({
  prefs, onToggleSource, onToggleTopic, onResetPrefs, onClearViewed, onClose,
  onAddCustomSource, onRemoveCustomSource, onExportOPML, onImportOPML,
  onExportBookmarks, onImportBookmarks,
  onAddLabel, onDeleteLabel,   onSuggestLabels,
  syncActive, syncStatus, syncedAt, syncError, syncUrl, syncEnvError,
  metaStatus, metaError, metaEnvError,
  onForceMetaSync, onForceSync, onGenerateLink, onRevoke, onToggleAiBar,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<Element | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bmFileInputRef = useRef<HTMLInputElement>(null);

  // Custom source form
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl]   = useState('');

  // Import status: separate for OPML and bookmarks
  const [importStatus, setImportStatus]   = useState<'idle' | 'ok' | 'error'>('idle');
  const [bmImportStatus, setBmImportStatus] = useState<'idle' | 'ok' | 'error'>('idle');

  // AI Labels
  const [newLabelName, setNewLabelName]   = useState('');
  const [newLabelColor, setNewLabelColor] = useState('#6c63ff');
  const [suggestions, setSuggestions]     = useState<string[]>([]);
  const [suggesting, setSuggesting]       = useState(false);

  // Sync QR code (for live sync URL)
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [copied, setCopied]       = useState(false);

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
    const id = `custom-${Date.now().toString(36)}`;
    onAddCustomSource({ id, name, feedUrl });
    setNewName('');
    setNewUrl('');
  };

  useEffect(() => {
    if (!syncUrl) { setQrDataUrl(''); return; }
    QRCode.toDataURL(syncUrl, { width: 200, margin: 2 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(''));
  }, [syncUrl]);

  const handleCopyShareUrl = useCallback(async () => {
    if (!syncUrl) return;
    try {
      await navigator.clipboard.writeText(syncUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback: select the text
    }
  }, [syncUrl]);

  const handleAddLabel = (e: React.FormEvent) => {
    e.preventDefault();
    const name = newLabelName.trim();
    if (!name) return;
    const id = `lbl-${Date.now().toString(36)}`;
    onAddLabel({ id, name, color: newLabelColor });
    setNewLabelName('');
    setNewLabelColor('#6c63ff');
  };

  const handleSuggest = async () => {
    setSuggesting(true);
    try {
      const results = await onSuggestLabels([]);
      setSuggestions(results);
    } finally {
      setSuggesting(false);
    }
  };

  const handleAcceptSuggestion = (name: string) => {
    const id = `lbl-${Date.now().toString(36)}`;
    onAddLabel({ id, name, color: '#6c63ff' });
    setSuggestions(prev => prev.filter(s => s !== name));
  };

  const handleDismissSuggestion = (name: string) => {
    setSuggestions(prev => prev.filter(s => s !== name));
  };

  const handleOPMLFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const xml = ev.target?.result as string;
      const ok = onImportOPML(xml);
      setImportStatus(ok ? 'ok' : 'error');
      if (ok) setTimeout(() => setImportStatus('idle'), 3000);
    };
    reader.readAsText(file);
    // Reset so the same file can be re-imported
    e.target.value = '';
  };

  const handleBMFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const html = ev.target?.result as string;
      const ok = onImportBookmarks(html);
      setBmImportStatus(ok ? 'ok' : 'error');
      if (ok) setTimeout(() => setBmImportStatus('idle'), 3000);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="settings-panel" ref={panelRef}>
        <div className="settings-header">
          <h2>Customize Feed</h2>
          <button className="btn-close" onClick={onClose} aria-label="Close settings">✕</button>
        </div>

        {/* ── Topics ─────────────────────────────────────────────────── */}
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

        {/* ── Sources (built-in + custom unified) ────────────────────── */}
        <section className="settings-section">
          <h3>Sources</h3>
          <p className="settings-hint">Toggle sources on or off. Custom sources can also be removed entirely.</p>
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
                  <span className="source-cat">{meta?.label ?? source.category}</span>
                  <span className={`toggle-indicator ${enabled ? 'on' : ''}`} />
                </button>
              );
            })}

            {prefs.customSources.map(src => {
              const enabled = isSourceEnabled(src.id, prefs);
              return (
                <div key={src.id} className="source-row-custom">
                  <button
                    className={`source-item source-item-flex ${enabled ? 'on' : 'off'}`}
                    onClick={() => onToggleSource(src.id)}
                    title={src.feedUrl}
                  >
                    <span className="source-dot" style={{ background: '#888' }} />
                    <span className="source-name">{src.name}</span>
                    <span className="source-cat">Custom</span>
                    <span className={`toggle-indicator ${enabled ? 'on' : ''}`} />
                  </button>
                  <button
                    className="btn-remove-source"
                    onClick={() => onRemoveCustomSource(src.id)}
                    aria-label={`Remove ${src.name}`}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>

          <p className="settings-hint" style={{ marginTop: '14px' }}>Add a custom RSS or Atom feed URL.</p>
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
            <button type="submit" className="btn-add-source">Add source</button>
          </form>
        </section>

        {/* ── OPML Export / Import ───────────────────────────────────── */}
        <section className="settings-section">
          <h3>Export / Import</h3>
          <p className="settings-hint">
            Download your subscriptions as an <strong>OPML</strong> file — compatible with any feed reader.
            Import an OPML file to restore or replace your source list (enabled/disabled state and custom feeds).
          </p>

          <div className="opml-actions">
            <button type="button" className="btn-bookmark" onClick={onExportOPML}>
              Download OPML
            </button>

            <div className="opml-import-row">
              <input
                ref={fileInputRef}
                type="file"
                accept=".opml,.xml"
                className="opml-file-input"
                aria-label="Import OPML file"
                onChange={handleOPMLFile}
              />
              <button
                type="button"
                className="btn-add-source"
                onClick={() => fileInputRef.current?.click()}
              >
                Import OPML file
              </button>
            </div>
          </div>

          {importStatus === 'ok'    && <p className="import-status ok">Imported — sources updated and feed refreshing.</p>}
          {importStatus === 'error' && <p className="import-status error">Could not read that file — make sure it is a valid OPML or XML file.</p>}

          <div className="opml-divider" />

          <p className="settings-hint">
            <strong>Saved articles</strong> — export your starred articles as a browser bookmarks file,
            or import a bookmarks folder to add those URLs to your Saved list.
          </p>
          <div className="opml-actions">
            <button type="button" className="btn-add-source" onClick={onExportBookmarks}>
              Download saves as bookmarks
            </button>
            <div className="opml-import-row">
              <input
                ref={bmFileInputRef}
                type="file"
                accept=".html,.htm"
                className="opml-file-input"
                aria-label="Import bookmarks HTML file"
                onChange={handleBMFile}
              />
              <button
                type="button"
                className="btn-add-source"
                onClick={() => bmFileInputRef.current?.click()}
              >
                Import bookmarks file
              </button>
            </div>
          </div>
          {bmImportStatus === 'ok'    && <p className="import-status ok">Imported — bookmarks added to your Saved list.</p>}
          {bmImportStatus === 'error' && <p className="import-status error">Could not read that file — make sure it is a browser bookmarks HTML export.</p>}
        </section>

        {/* ── AI Labels ──────────────────────────────────────────────── */}
        <section className="settings-section">
          <h3>AI Labels</h3>
          <p className="settings-hint">
            Create topic labels to tag your feed. On Chrome 138+, on-device AI classifies articles automatically.
          </p>

          {(prefs.userLabels ?? []).length > 0 && (
            <div className="label-list">
              {(prefs.userLabels ?? []).map(lbl => (
                <div key={lbl.id} className="label-list-item">
                  <span className="label-list-dot" style={{ background: lbl.color }} />
                  <span className="label-list-name">{lbl.name}</span>
                  <button
                    className="btn-remove-label"
                    onClick={() => onDeleteLabel(lbl.id)}
                    aria-label={`Delete label ${lbl.name}`}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          <form className="add-label-form" onSubmit={handleAddLabel}>
            <input
              type="text"
              className="custom-source-input add-label-input"
              placeholder="New label name"
              value={newLabelName}
              onChange={e => setNewLabelName(e.target.value)}
              required
            />
            <input
              type="color"
              className="add-label-color"
              value={newLabelColor}
              onChange={e => setNewLabelColor(e.target.value)}
              title="Label colour"
            />
            <button type="submit" className="btn-add-source">Add</button>
          </form>

          {isPromptApiAvailable() && (
            <>
              <button
                type="button"
                className="btn-add-source"
                style={{ marginTop: '10px' }}
                onClick={handleSuggest}
                disabled={suggesting}
              >
                {suggesting ? 'Thinking…' : 'Suggest labels with AI'}
              </button>

              {suggestions.length > 0 && (
                <div className="suggestion-chips">
                  {suggestions.map(name => (
                    <div key={name} className="suggestion-chip">
                      <span className="suggestion-chip-name">{name}</span>
                      <button
                        className="btn-accept-suggestion"
                        onClick={() => handleAcceptSuggestion(name)}
                      >
                        + Add
                      </button>
                      <button
                        className="btn-dismiss-suggestion"
                        onClick={() => handleDismissSuggestion(name)}
                        aria-label={`Dismiss ${name}`}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </section>

        {/* ── Shared metadata ──────────────────────────────────────────── */}
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

        {/* ── Sync across devices ──────────────────────────────────────── */}
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
              {syncError && <p className="sync-error">{syncError}</p>}
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
                  {syncStatus === 'active' && syncedAt && `Synced ${formatSyncedAt(syncedAt)}`}
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
            </>
          )}
        </section>

        {/* ── Preferences ────────────────────────────────────────────── */}
        <section className="settings-section">
          <h3>Preferences</h3>
          <p className="settings-hint">Clear viewed history to see previously read articles again.</p>
          <label className="settings-toggle-row">
            <input
              type="checkbox"
              checked={!prefs.hideAiBar}
              onChange={onToggleAiBar}
            />
            Show Chrome AI bar
          </label>
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

        {/* ── About ──────────────────────────────────────────────────── */}
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
