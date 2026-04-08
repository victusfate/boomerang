import type { Topic, UserPrefs } from '../types';

export const TOPIC_META: Record<Topic, { label: string; color: string }> = {
  technology:   { label: 'Tech',          color: '#4a90d9' },
  science:      { label: 'Science',       color: '#50c878' },
  world:        { label: 'World',         color: '#e05c5c' },
  business:     { label: 'Business',      color: '#e8a020' },
  health:       { label: 'Health',        color: '#ff8c42' },
  environment:  { label: 'Environment',   color: '#4caf78' },
  sports:       { label: 'Sports',        color: '#42a5c7' },
  entertainment:{ label: 'Entertainment', color: '#b57bee' },
  general:      { label: 'General',       color: '#888888' },
};

const ALL_TOPICS = Object.keys(TOPIC_META) as Topic[];

interface Props {
  prefs: UserPrefs;
  activeFilter: Topic | null;
  onFilter: (topic: Topic | null) => void;
}

export function TopicFilter({ prefs, activeFilter, onFilter }: Props) {
  return (
    <div className="topic-filter" role="toolbar" aria-label="Filter by topic">
      <button
        className={`topic-pill ${activeFilter === null ? 'active' : ''}`}
        onClick={() => onFilter(null)}
      >
        All
      </button>
      {ALL_TOPICS.filter(t => t !== 'general').map(topic => {
        const meta = TOPIC_META[topic];
        const w = prefs.topicWeights[topic] ?? 1.0;
        const boosted = w > 1.2;
        return (
          <button
            key={topic}
            className={`topic-pill ${activeFilter === topic ? 'active' : ''}`}
            style={activeFilter === topic ? { '--pill-color': meta.color } as React.CSSProperties : undefined}
            onClick={() => onFilter(activeFilter === topic ? null : topic)}
          >
            {boosted && <span className="pill-dot" style={{ background: meta.color }} />}
            {meta.label}
          </button>
        );
      })}
    </div>
  );
}
