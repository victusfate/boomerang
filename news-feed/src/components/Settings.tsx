import { useEffect, useRef } from 'react';
import { DEFAULT_SOURCES } from '../services/newsService';
import { isSourceEnabled, isTopicEnabled } from '../services/storage';
import type { Topic, UserPrefs } from '../types';
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
}

export function Settings({ prefs, onToggleSource, onToggleTopic, onResetPrefs, onClearViewed, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<Element | null>(null);

  useEffect(() => {
    previousFocusRef.current = document.activeElement;

    // Move focus into the panel on open
    const firstFocusable = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    firstFocusable?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }

      // Focus trap
      if (e.key === 'Tab' && panelRef.current) {
        const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      (previousFocusRef.current as HTMLElement | null)?.focus();
    };
  }, [onClose]);

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
              const meta = TOPIC_META[topic];
              const enabled = isTopicEnabled(topic, prefs);
              const weight = prefs.topicWeights[topic] ?? 1.0;
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
              const meta = TOPIC_META[source.category];
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

        <section className="settings-section">
          <h3>Preferences</h3>
          <p className="settings-hint">
            Clear viewed history to see previously read articles again.
          </p>
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
