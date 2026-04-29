import { storeTokenHash } from './auth';

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomBase64Url(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  let binary = '';
  arr.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export async function createRoom(r2: R2Bucket): Promise<{ roomId: string; token: string }> {
  const roomId = randomHex(32);
  const token = randomBase64Url(32);
  await storeTokenHash(r2, roomId, token);
  return { roomId, token };
}

export async function deleteRoom(r2: R2Bucket, roomId: string): Promise<void> {
  const listed = await r2.list({ prefix: roomId + '/' });
  await Promise.all(listed.objects.map(obj => r2.delete(obj.key)));
  // Also delete the token key (stored as {roomId}/.token, no trailing slash prefix)
  await r2.delete(roomId + '/.token');
}
