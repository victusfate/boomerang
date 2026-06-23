import { randomBase64Url } from '../sync/room.ts';
import type { CaptureDestination, CaptureTokenRecord } from './types.ts';

const TOKEN_BYTES = 32;
const FORWARD_PREFIX = 'capture-token:';
const REVERSE_PREFIX = 'capture-room:';

function forwardKey(tokenId: string): string {
  return FORWARD_PREFIX + tokenId;
}

function reverseKey(roomId: string): string {
  return REVERSE_PREFIX + roomId;
}

function recordFor(roomId: string, destination: CaptureDestination): CaptureTokenRecord {
  if (destination.type === 'saved-list') {
    return { roomId, destinationType: 'saved-list' };
  }
  const { owner, repo, path, branch } = destination;
  return { roomId, destinationType: 'github', destinationConfig: { owner, repo, path, branch } };
}

export async function generateCaptureToken(
  kv: KVNamespace,
  roomId: string,
  destination: CaptureDestination,
): Promise<{ captureToken: string }> {
  const existing = await kv.get(reverseKey(roomId));
  if (existing) await kv.delete(forwardKey(existing));

  const captureToken = randomBase64Url(TOKEN_BYTES);
  await kv.put(forwardKey(captureToken), JSON.stringify(recordFor(roomId, destination)));
  await kv.put(reverseKey(roomId), captureToken);
  return { captureToken };
}

export async function revokeCaptureToken(kv: KVNamespace, roomId: string): Promise<void> {
  const tokenId = await kv.get(reverseKey(roomId));
  if (!tokenId) return;
  await kv.delete(forwardKey(tokenId));
  await kv.delete(reverseKey(roomId));
}

export async function resolveCaptureToken(
  kv: KVNamespace,
  tokenId: string,
): Promise<CaptureTokenRecord | null> {
  return kv.get(forwardKey(tokenId), 'json');
}
