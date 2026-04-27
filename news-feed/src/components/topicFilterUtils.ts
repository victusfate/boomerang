import type { Topic, UserLabel } from '../types';

export const TOPIC_META: Record<Topic, { label: string; color: string }> = {
  technology:    { label: 'Tech',          color: '#4a90d9' },
  science:       { label: 'Science',       color: '#50c878' },
  world:         { label: 'World',         color: '#e05c5c' },
  business:      { label: 'Business',      color: '#e8a020' },
  health:        { label: 'Health',        color: '#ff8c42' },
  environment:   { label: 'Environment',   color: '#4caf78' },
  sports:        { label: 'Sports',        color: '#42a5c7' },
  entertainment: { label: 'Entertainment', color: '#b57bee' },
  general:       { label: 'General',       color: '#888888' },
};

export const SHOWN_TOPICS = (Object.keys(TOPIC_META) as Topic[]).filter(t => t !== 'general');

export function buildFilterState(userLabels: UserLabel[]) {
  return {
    labelPills: userLabels,
    topicPills: SHOWN_TOPICS,
    showMoreButton: userLabels.length > 0,
  };
}
