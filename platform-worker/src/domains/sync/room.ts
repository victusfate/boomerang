import { storeTokenHash } from './auth.ts';

const ROOM_ID_HEX_BYTES = 32;
const TOKEN_BASE64_BYTES = 32;

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function randomBase64Url(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  let binary = '';
  arr.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export async function createRoom(r2: R2Bucket): Promise<{ roomId: string; token: string }> {
  const roomId = randomHex(ROOM_ID_HEX_BYTES);
  const token = randomBase64Url(TOKEN_BASE64_BYTES);
  await storeTokenHash(r2, roomId, token);
  return { roomId, token };
}

export async function deleteRoom(r2: R2Bucket, roomId: string): Promise<void> {
  // r2.list() returns at most 1000 objects per page — follow the cursor so
  // large rooms are fully deleted, not orphaned past the first page.
  let cursor: string | undefined;
  do {
    const listed = await r2.list({ prefix: roomId + '/', cursor });
    await Promise.all(listed.objects.map(obj => r2.delete(obj.key)));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  await r2.delete(roomId + '/.token');
}
