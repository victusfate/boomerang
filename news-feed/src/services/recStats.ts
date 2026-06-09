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
  tags:    Record<string, ActionCounts>;
  actions: ActionCounts;
  total:   number;
}

const STATS_KEY = 'rec:stats:v1';

const EMPTY_STATS: RecStats = { sources: {}, topics: {}, tags: {}, actions: {}, total: 0 };

export async function loadRecStats(): Promise<RecStats> {
  const s = await kvGet<RecStats>(STATS_KEY);
  return s ? { ...EMPTY_STATS, ...s } : { ...EMPTY_STATS };
}

export async function clearRecStats(): Promise<void> {
  await kvSet(STATS_KEY, { ...EMPTY_STATS });
}

// Interactions fire-and-forget from scroll handlers; chain writes so an
// overlapping read-modify-write can't drop increments.
let writeChain: Promise<void> = Promise.resolve();

export function recordInteraction(input: {
  sourceId: string;
  topics: Topic[];
  tags?: string[];
  action: string;
}): Promise<void> {
  writeChain = writeChain.catch(() => {}).then(() => recordInteractionNow(input));
  return writeChain;
}

async function recordInteractionNow(input: {
  sourceId: string;
  topics: Topic[];
  tags?: string[];
  action: string;
}): Promise<void> {
  const stats = await loadRecStats();
  const a = input.action;
  const bump = (bag: Record<string, ActionCounts>, key: string) => {
    if (!bag[key]) bag[key] = {};
    (bag[key] as Record<string, number>)[a] = ((bag[key] as Record<string, number>)[a] ?? 0) + 1;
  };

  stats.total = (stats.total ?? 0) + 1;
  (stats.actions as Record<string, number>)[a] = ((stats.actions as Record<string, number>)[a] ?? 0) + 1;

  bump(stats.sources, input.sourceId);
  for (const topic of input.topics) bump(stats.topics, topic);
  for (const tag   of input.tags ?? []) bump(stats.tags, tag);

  await kvSet(STATS_KEY, stats);
}

export function engagementScore(counts: ActionCounts): number {
  return Object.entries(counts).reduce(
    (sum, [action, count]) => sum + (ACTION_WEIGHT[action] ?? 0) * (count ?? 0),
    0,
  );
}
