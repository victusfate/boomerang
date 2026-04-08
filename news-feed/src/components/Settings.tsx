import { DEFAULT_SOURCES } from '../services/newsService';
import { isSourceEnabled, isTopicEnabled } from '../services/storage';
import type { Topic, UserPrefs } from '../types';
import { TOPIC_META } from './TopicFilter';

const ALL_TOPICS = (Object.keys(TOPIC_META) as Topic[]).filter(t => t !== 'general');

interface Props {
  prefs: UserPrefs;
  onToggleSource: (id: string) => void;
  onToggleTopic: (topic: Topic) => void;
  onClose: () => void;
}

export function Settings({ prefs, onToggleSource, onToggleTopic, onClose }: Props) {
  return (
    <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="settings-panel">
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
