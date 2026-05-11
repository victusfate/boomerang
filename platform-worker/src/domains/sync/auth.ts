const TOKEN_SUFFIX = '/.token';

export async function sha256Hex(value: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function storeTokenHash(r2: R2Bucket, roomId: string, token: string): Promise<void> {
  const hash = await sha256Hex(token);
  await r2.put(roomId + TOKEN_SUFFIX, hash);
}

export async function verifyToken(r2: R2Bucket, roomId: string, token: string): Promise<boolean> {
  const obj = await r2.get(roomId + TOKEN_SUFFIX);
  if (!obj) return false;
  const stored = await obj.text();
  const hash = await sha256Hex(token);
  return stored === hash;
}

export function extractBearer(request: Request): string | null {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice('Bearer '.length).trim();
}
