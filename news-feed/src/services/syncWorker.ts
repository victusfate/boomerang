import type { Article, ArticleTag, LabelHit, UserPrefs } from '../types.ts';
import { mergePrefs, mergeArticleTags, mergeLabelHits, dehydrate, hydrate, type SyncPayloadV1 } from './syncShare.ts';

/** `sourceId` for bookmark rows synthesized so sync payloads cover every `prefs.savedId`. */
export const SYNC_PLACEHOLDER_SOURCE_ID = 'boomerang-sync-placeholder';

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
  unauthorized?: boolean;
}

export async function fetchMeta(room: SyncRoom): Promise<MetaResponse | null> {
  const res = await fetch(`${room.workerUrl}/sync/${room.roomId}/meta`);
  if (res.status === 404) return null;
  if (res.status === 401) return { payload: {} as SyncPayloadV1, etag: '', unauthorized: true };
  if (!res.ok) throw new Error(`fetchMeta failed: ${res.status}`);
  const etag = res.headers.get('ETag') ?? '';
  const payload = await res.json() as SyncPayloadV1;
  return { payload, etag };
}

export async function pushMeta(
  room: SyncRoom,
  payload: SyncPayloadV1,
  etag?: string,
): Promise<{ ok: boolean; conflict: boolean; unauthorized: boolean }> {
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

  if (res.status === 412) return { ok: false, conflict: true, unauthorized: false };
  if (res.status === 401) return { ok: false, conflict: false, unauthorized: true };
  if (!res.ok) return { ok: false, conflict: false, unauthorized: false };
  return { ok: true, conflict: false, unauthorized: false };
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
    savedArticles: mergeSavedArticleSnapshots(hydrate(remote.savedArticles ?? []), local.savedArticles),
  };
}

// ── Payload materialization (every savedId → one savedArticles row) ─────────────

function placeholderSavedArticle(id: string): Article {
  return {
    id,
    title: 'Saved article',
    url: 'https://example.com/',
    description:
      'This bookmark was saved on another device before full article metadata was synced. Refresh the feed or open it where you saved it to restore the link.',
    publishedAt: new Date(0),
    source: 'Sync',
    sourceId: SYNC_PLACEHOLDER_SOURCE_ID,
    topics: ['general'],
  };
}

/**
 * One dehydrated row per `prefs.savedIds` entry, using known article bodies when available.
 * Prevents remote clients from showing fewer saved cards than `savedIds.length`.
 */
export function materializeSavedArticlesForSync(prefs: UserPrefs, known: Article[]): Article[] {
  const byId = new Map<string, Article>();
  for (const a of known) {
    byId.set(a.id, a);
  }
  return prefs.savedIds.map(id => byId.get(id) ?? placeholderSavedArticle(id));
}

/**
 * Merge hydrated bookmark rows from a sync pull. Prefers a non-placeholder row when one side
 * only has a placeholder for the same `id` (see `materializeSavedArticlesForSync`).
 */
export function mergeSavedArticleSnapshots(fromRemote: Article[], fromLocal: Article[]): Article[] {
  const map = new Map<string, Article>();
  for (const r of fromRemote) {
    map.set(r.id, r);
  }
  for (const l of fromLocal) {
    const prev = map.get(l.id);
    if (prev === undefined) {
      map.set(l.id, l);
      continue;
    }
    const prevPh = prev.sourceId === SYNC_PLACEHOLDER_SOURCE_ID;
    const lPh = l.sourceId === SYNC_PLACEHOLDER_SOURCE_ID;
    if (prevPh && !lPh) {
      map.set(l.id, l);
    } else if (!prevPh && lPh) {
      // keep prev
    } else {
      map.set(l.id, l);
    }
  }
  return Array.from(map.values());
}

export function buildPayload(
  prefs: UserPrefs,
  articleTags: ArticleTag[],
  labelHits: LabelHit[],
  savedArticles: Article[],
): SyncPayloadV1 {
  const materialized = materializeSavedArticlesForSync(prefs, savedArticles);
  return { v: 1, prefs, articleTags, labelHits, savedArticles: dehydrate(materialized) };
}
