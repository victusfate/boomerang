import type { Topic } from '../types';
import { kvGet, kvSet } from './kvStore';

export type RecAction = 'read' | 'upvote' | 'downvote' | 'save' | 'seen';

export interface RecInteractionInput {
  articleId: string;
  sourceId:  string;
  topics:    Topic[];
  action:    RecAction;
  ts:        number;   // epoch ms — set at interaction time, not flush time
}

interface RecEvent extends RecInteractionInput {
  userId: string;
}

export interface RecResponse {
  articleIds:  string[];
  generatedAt: number;
}

const USER_ID_KEY = 'rec:userId';

export async function getOrCreateRecUserId(): Promise<string> {
  const existing = await kvGet<string>(USER_ID_KEY);
  if (existing) return existing;
  const id = crypto.randomUUID();
  await kvSet(USER_ID_KEY, id);
  return id;
}

export async function postInteractions(
  workerBase: string,
  userId: string,
  inputs: RecInteractionInput[],
): Promise<void> {
  const events: RecEvent[] = inputs.map(e => ({ ...e, userId }));
  await fetch(`${workerBase}/interactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
  });
}

export async function fetchRecommendations(
  workerBase: string,
  userId: string,
  limit = 50,
): Promise<RecResponse> {
  const res = await fetch(
    `${workerBase}/recommendations/${encodeURIComponent(userId)}?limit=${limit}`,
  );
  if (!res.ok) throw new Error(`rec-worker ${res.status}`);
  return res.json() as Promise<RecResponse>;
}
