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
  onExportOPML: () => void;
  onImportOPML: (xml: string) => boolean;
  onExportBookmarks: () => void;
  onImportBookmarks: (html: string) => boolean;
}

export function Settings({
  prefs, onToggleSource, onToggleTopic, onResetPrefs, onClearViewed, onClose,
  onAddCustomSource, onRemoveCustomSource, onExportOPML, onImportOPML,
  onExportBookmarks, onImportBookmarks,
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

        {/* ── Preferences ────────────────────────────────────────────── */}
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
