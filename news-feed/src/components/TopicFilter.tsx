import { useState } from 'react';
import type { Topic, UserPrefs, UserLabel, ActiveFilter } from '../types';
import { TOPIC_META, SHOWN_TOPICS, buildFilterState } from './topicFilterUtils';

export { TOPIC_META };

interface Props {
  prefs: UserPrefs;
  userLabels: UserLabel[];
  activeFilter: ActiveFilter;
  onFilter: (f: ActiveFilter) => void;
}

export function TopicFilter({ prefs, userLabels, activeFilter, onFilter }: Props) {
  const [moreOpen, setMoreOpen] = useState(false);
  const { showMoreButton } = buildFilterState(userLabels);

  function handleTopicClick(topic: Topic) {
    const next: ActiveFilter =
      activeFilter?.kind === 'topic' && activeFilter.value === topic
        ? null
        : { kind: 'topic', value: topic };
    onFilter(next);
  }

  function handleLabelClick(labelId: string) {
    const next: ActiveFilter =
      activeFilter?.kind === 'label' && activeFilter.value === labelId
        ? null
        : { kind: 'label', value: labelId };
    onFilter(next);
  }

  const topicPills = SHOWN_TOPICS.map(topic => {
    const meta = TOPIC_META[topic];
    const w = prefs.topicWeights[topic] ?? 1.0;
    const boosted = w > 1.2;
    const isActive = activeFilter?.kind === 'topic' && activeFilter.value === topic;
    return (
      <button
        key={topic}
        className={`topic-pill ${isActive ? 'active' : ''}`}
        style={isActive ? { '--pill-color': meta.color } as React.CSSProperties : undefined}
        onClick={() => handleTopicClick(topic)}
      >
        {boosted && <span className="pill-dot" style={{ background: meta.color }} />}
        {meta.label}
      </button>
    );
  });

  return (
    <div className="topic-filter-wrap">
      <div className="topic-filter" role="toolbar" aria-label="Filter by topic">
        <button
          className={`topic-pill ${activeFilter === null ? 'active' : ''}`}
          onClick={() => onFilter(null)}
        >
          All
        </button>

        {userLabels.map(lbl => {
          const isActive = activeFilter?.kind === 'label' && activeFilter.value === lbl.id;
          return (
            <button
              key={lbl.id}
              className={`topic-pill ${isActive ? 'active' : ''}`}
              style={isActive ? { '--pill-color': lbl.color } as React.CSSProperties : undefined}
              onClick={() => handleLabelClick(lbl.id)}
            >
              {lbl.name}
            </button>
          );
        })}

        {showMoreButton ? (
          <button
            className={`topic-pill topic-pill-more${moreOpen ? ' active' : ''}`}
            onClick={() => setMoreOpen(o => !o)}
            aria-expanded={moreOpen}
          >
            Topics {moreOpen ? '▲' : '▼'}
          </button>
        ) : (
          topicPills
        )}
      </div>

      {showMoreButton && moreOpen && (
        <div className="topic-overflow-panel" role="toolbar" aria-label="Filter by built-in topic">
          {topicPills}
        </div>
      )}
    </div>
  );
}
