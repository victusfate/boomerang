import { kvGet, kvSet } from './kvStore';
import type { Topic } from '../types';

export const ACTION_WEIGHT: Record<string, number> = {
  save: 2.0,
  upvote: 1.0,
  read: 0.5,
  seen: 0.1,
  downvote: -1.0,
};

export interface ActionCounts {
  read?: number;
  save?: number;
  upvote?: number;
  downvote?: number;
  seen?: number;
}

export interface RecStats {
  sources: Record<string, ActionCounts>;
  topics:  Record<string, ActionCounts>;
  actions: ActionCounts;
  total:   number;
}

const STATS_KEY = 'rec:stats:v1';

export async function loadRecStats(): Promise<RecStats> {
  return (await kvGet<RecStats>(STATS_KEY)) ?? { sources: {}, topics: {}, actions: {}, total: 0 };
}

export async function clearRecStats(): Promise<void> {
  await kvSet(STATS_KEY, { sources: {}, topics: {}, actions: {}, total: 0 });
}

export async function recordInteraction(input: {
  sourceId: string;
  topics: Topic[];
  action: string;
}): Promise<void> {
  const stats = await loadRecStats();
  const a = input.action;

  stats.total = (stats.total ?? 0) + 1;
  (stats.actions as Record<string, number>)[a] = ((stats.actions as Record<string, number>)[a] ?? 0) + 1;

  if (!stats.sources[input.sourceId]) stats.sources[input.sourceId] = {};
  (stats.sources[input.sourceId] as Record<string, number>)[a] =
    ((stats.sources[input.sourceId] as Record<string, number>)[a] ?? 0) + 1;

  for (const topic of input.topics) {
    if (!stats.topics[topic]) stats.topics[topic] = {};
    (stats.topics[topic] as Record<string, number>)[a] =
      ((stats.topics[topic] as Record<string, number>)[a] ?? 0) + 1;
  }

  await kvSet(STATS_KEY, stats);
}

export function engagementScore(counts: ActionCounts): number {
  return Object.entries(counts).reduce(
    (sum, [action, count]) => sum + (ACTION_WEIGHT[action] ?? 0) * (count ?? 0),
    0,
  );
}
