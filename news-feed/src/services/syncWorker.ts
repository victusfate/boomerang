import type { Article, ArticleTag, LabelHit, UserPrefs } from '../types.ts';
import { mergePrefs, mergeArticleTags, mergeLabelHits, mergeArticlesById, dehydrate, hydrate, type SyncPayloadV1 } from './syncShare.ts';

export const SYNC_STORAGE_KEY = 'BOOMERANG_SYNC';
const FRAGMENT_PREFIX = '#sync-room=';

export interface SyncRoom {
  roomId: string;
  token: string;
  workerUrl: string;
}

// ── URL helpers ────────────────────────────────────────────────────────────────

export function buildSyncFragment(roomId: string, token: string, workerUrl: string): string {
  return `${FRAGMENT_PREFIX}${roomId}:${token}:${encodeURIComponent(workerUrl)}`;
}

export function buildSyncUrl(workerUrl: string, roomId: string, token: string): string {
  const base = typeof location !== 'undefined' ? `${location.origin}${location.pathname}` : '';
  return `${base}${buildSyncFragment(roomId, token, workerUrl)}`;
}

export function parseSyncFragment(hash = typeof location !== 'undefined' ? location.hash : ''): SyncRoom | null {
  if (!hash.startsWith(FRAGMENT_PREFIX)) return null;
  const parts = hash.slice(FRAGMENT_PREFIX.length).split(':');
  if (parts.length < 3) return null;
  const [roomId, token, ...rest] = parts;
  const workerUrl = decodeURIComponent(rest.join(':'));
  if (!roomId || !token || !workerUrl) return null;
  return { roomId, token, workerUrl };
}

export function saveSyncRoom(room: SyncRoom): void {
  localStorage.setItem(SYNC_STORAGE_KEY, JSON.stringify(room));
}

export function loadSyncRoom(): SyncRoom | null {
  try {
    const raw = localStorage.getItem(SYNC_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as SyncRoom;
  } catch {
    return null;
  }
}

export function clearSyncRoom(): void {
  localStorage.removeItem(SYNC_STORAGE_KEY);
}

// ── Worker API calls ───────────────────────────────────────────────────────────

export async function createSyncRoom(workerUrl: string): Promise<SyncRoom> {
  const res = await fetch(`${workerUrl}/sync/room`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to create sync room: ${res.status}`);
  const { roomId, token } = await res.json() as { roomId: string; token: string };
  return { roomId, token, workerUrl };
}

export interface MetaResponse {
  payload: SyncPayloadV1;
  etag: string;
}

export async function fetchMeta(room: SyncRoom): Promise<MetaResponse | null> {
  const res = await fetch(`${room.workerUrl}/sync/${room.roomId}/meta`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetchMeta failed: ${res.status}`);
  const etag = res.headers.get('ETag') ?? '';
  const payload = await res.json() as SyncPayloadV1;
  return { payload, etag };
}

export async function pushMeta(
  room: SyncRoom,
  payload: SyncPayloadV1,
  etag?: string,
): Promise<{ ok: boolean; conflict: boolean }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${room.token}`,
  };
  if (etag) headers['If-Match'] = etag;

  const res = await fetch(`${room.workerUrl}/sync/${room.roomId}/meta`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(payload),
  });

  if (res.status === 412) return { ok: false, conflict: true };
  if (!res.ok) return { ok: false, conflict: false };
  return { ok: true, conflict: false };
}

export async function deleteRoom(room: SyncRoom): Promise<void> {
  await fetch(`${room.workerUrl}/sync/${room.roomId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${room.token}` },
  });
}

// ── Merge helper ───────────────────────────────────────────────────────────────

export function mergePayload(
  local: { prefs: UserPrefs; articleTags: ArticleTag[]; labelHits: LabelHit[]; savedArticles: Article[] },
  remote: SyncPayloadV1,
): { prefs: UserPrefs; articleTags: ArticleTag[]; labelHits: LabelHit[]; savedArticles: Article[] } {
  return {
    prefs: mergePrefs(local.prefs, remote.prefs),
    articleTags: mergeArticleTags(local.articleTags, remote.articleTags ?? []),
    labelHits: mergeLabelHits(local.labelHits, remote.labelHits ?? []),
    savedArticles: mergeArticlesById(local.savedArticles, hydrate(remote.savedArticles ?? [])),
  };
}

export function buildPayload(
  prefs: UserPrefs,
  articleTags: ArticleTag[],
  labelHits: LabelHit[],
  savedArticles: Article[],
): SyncPayloadV1 {
  return { v: 1, prefs, articleTags, labelHits, savedArticles: dehydrate(savedArticles) };
}
