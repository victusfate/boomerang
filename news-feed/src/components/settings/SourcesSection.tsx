import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_SOURCES } from '../../services/newsService';
import { isSourceEnabled } from '../../services/storage';
import type { CustomSource, UserPrefs } from '../../types';
import { TOPIC_META } from '../topicFilterUtils';

const IMPORT_STATUS_RESET_MS = 3_000;

function makeImportHandler(
  importFn: (text: string) => boolean,
  setStatus: React.Dispatch<React.SetStateAction<'idle' | 'ok' | 'error'>>,
  scheduleReset: (fn: () => void, ms: number) => void,
): (e: React.ChangeEvent<HTMLInputElement>) => void {
  return (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const ok = importFn(text);
      setStatus(ok ? 'ok' : 'error');
      if (ok) scheduleReset(() => setStatus('idle'), IMPORT_STATUS_RESET_MS);
    };
    reader.readAsText(file);
    e.target.value = '';
  };
}

interface Props {
  prefs: UserPrefs;
  onToggleSource: (id: string) => void;
  onAddCustomSource: (source: CustomSource) => void;
  onRemoveCustomSource: (id: string) => void;
  onExportOPML: () => void;
  onImportOPML: (xml: string) => boolean;
  onExportBookmarks: () => void;
  onImportBookmarks: (html: string) => boolean;
}

export function SourcesSection({
  prefs, onToggleSource, onAddCustomSource, onRemoveCustomSource,
  onExportOPML, onImportOPML, onExportBookmarks, onImportBookmarks,
}: Props) {
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl]   = useState('');
  const [importStatus, setImportStatus]     = useState<'idle' | 'ok' | 'error'>('idle');
  const [bmImportStatus, setBmImportStatus] = useState<'idle' | 'ok' | 'error'>('idle');
  const fileInputRef   = useRef<HTMLInputElement>(null);
  const bmFileInputRef = useRef<HTMLInputElement>(null);
  const statusTimersRef = useRef<number[]>([]);

  useEffect(() => () => {
    for (const id of statusTimersRef.current) clearTimeout(id);
  }, []);

  const scheduleStatusReset = useCallback((fn: () => void, ms: number) => {
    statusTimersRef.current.push(window.setTimeout(fn, ms));
  }, []);

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

  const handleOPMLFile = makeImportHandler(onImportOPML, setImportStatus, scheduleStatusReset);
  const handleBMFile = makeImportHandler(onImportBookmarks, setBmImportStatus, scheduleStatusReset);

  return (
    <>
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
    </>
  );
}
