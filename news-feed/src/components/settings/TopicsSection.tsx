import { isTopicEnabled } from '../../services/storage';
import type { Topic, UserPrefs } from '../../types';
import { TOPIC_META, SHOWN_TOPICS } from '../topicFilterUtils';

interface Props {
  prefs: UserPrefs;
  onToggleTopic: (topic: Topic) => void;
}

export function TopicsSection({ prefs, onToggleTopic }: Props) {
  return (
    <section className="settings-section">
      <h3>Topics</h3>
      <p className="settings-hint">Articles you read boost topic weight automatically.</p>
      <div className="settings-grid">
        {SHOWN_TOPICS.map(topic => {
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
  );
}
