/**
 * Capture connector client — bookmarklet builders and token management calls.
 * @module services/captureWorker
 * @category Capture
 */

import type { SyncRoom } from './syncWorker.ts';

export type CaptureDestination = { type: 'saved-list' };

const CAPTURE_STORAGE_KEY = 'BOOMERANG_CAPTURE';

export interface CaptureState {
  token: string;
  destination: CaptureDestination;
}

export function loadCaptureState(): CaptureState | null {
  try {
    const raw = localStorage.getItem(CAPTURE_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as CaptureState) : null;
  } catch {
    return null;
  }
}

export function saveCaptureState(state: CaptureState): void {
  localStorage.setItem(CAPTURE_STORAGE_KEY, JSON.stringify(state));
}

export function clearCaptureState(): void {
  localStorage.removeItem(CAPTURE_STORAGE_KEY);
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/$/, '');
}

export function buildCaptureEndpoint(workerUrl: string, captureToken: string): string {
  return `${stripTrailingSlash(workerUrl)}/api/capture/${captureToken}`;
}

export function buildSaveUrl(workerUrl: string, captureToken: string): string {
  return `${stripTrailingSlash(workerUrl)}/save/${captureToken}`;
}

/**
 * A bookmarklet the user drags to their bookmark bar. On click it navigates
 * to the worker's `/save` page — a user-initiated top-level navigation that
 * works on both desktop and mobile (window.open popup is blocked by iOS Safari
 * and Android Chrome when triggered from a bookmarklet). The save page shows a
 * confirmation and returns the user via history.back(). The selection is capped
 * so the page data fits within browser URL length limits.
 */
export function buildBookmarklet(workerUrl: string, captureToken: string): string {
  if (!captureToken) return '';
  const saveUrl = buildSaveUrl(workerUrl, captureToken);
  const body = [
    "var s=window.getSelection?String(window.getSelection()).slice(0,500):'';",
    `var u='${saveUrl}?u='+encodeURIComponent(location.href)+'&ti='+encodeURIComponent(document.title)+'&n='+encodeURIComponent(s);`,
    "location.href=u;",
  ].join('');
  return `javascript:(function(){${body}})();`;
}

export async function requestCaptureToken(
  workerUrl: string,
  room: SyncRoom,
  destination: CaptureDestination,
): Promise<string> {
  const res = await fetch(`${stripTrailingSlash(workerUrl)}/api/capture/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${room.token}` },
    body: JSON.stringify({ roomId: room.roomId, destination }),
  });
  if (!res.ok) throw new Error(`Capture token request failed (${res.status})`);
  const json = (await res.json()) as { captureToken: string };
  return json.captureToken;
}

export async function revokeCaptureTokenRequest(workerUrl: string, room: SyncRoom): Promise<void> {
  const res = await fetch(`${stripTrailingSlash(workerUrl)}/api/capture/token`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${room.token}` },
    body: JSON.stringify({ roomId: room.roomId }),
  });
  // quality-ok: magic-number — HTTP 204 No Content (revoke succeeds with no body)
  if (!res.ok && res.status !== 204) throw new Error(`Capture token revoke failed (${res.status})`);
}
