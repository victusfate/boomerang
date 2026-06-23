/**
 * Capture connector client — bookmarklet builders and token management calls.
 * @module services/captureWorker
 * @category Capture
 */

import type { SyncRoom } from './syncWorker.ts';

export type CaptureDestination =
  | { type: 'saved-list' }
  | { type: 'github'; owner: string; repo: string; path: string; branch: string };

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

/**
 * A bookmarklet the user drags to their bookmark bar. On click it POSTs the
 * current page (url, title, selected text) to the capture endpoint via
 * `sendBeacon` — a CORS-simple request that needs no preflight — and flashes a
 * brief confirmation.
 */
export function buildBookmarklet(workerUrl: string, captureToken: string): string {
  if (!captureToken) return '';
  const endpoint = buildCaptureEndpoint(workerUrl, captureToken);
  const body = [
    "var s=window.getSelection?String(window.getSelection()):'';",
    "var p={url:location.href,title:document.title,note:s,source:'bookmarklet'};",
    `var ok=navigator.sendBeacon('${endpoint}',new Blob([JSON.stringify(p)],{type:'text/plain'}));`,
    "var t=document.createElement('div');",
    "t.textContent=ok?'Saved to boomerang':'Capture failed';",
    "t.style.cssText='position:fixed;z-index:2147483647;top:16px;right:16px;padding:10px 14px;border-radius:8px;font:600 13px sans-serif;color:#fff;background:'+(ok?'#16a34a':'#dc2626');",
    'document.body.appendChild(t);',
    'setTimeout(function(){t.remove();},2000);',
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
  if (!res.ok && res.status !== 204) throw new Error(`Capture token revoke failed (${res.status})`);
}
