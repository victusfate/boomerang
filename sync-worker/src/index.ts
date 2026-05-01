import { corsHeaders } from './cors';
import { createRoom, deleteRoom } from './room';
import { verifyToken, extractBearer } from './auth';

const RATE_LIMIT_MAX_REQUESTS = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function json(data: unknown, request: Request, env: Env, init?: ResponseInit): Response {
  const headers = corsHeaders(request, env);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data), { ...init, headers });
}

function unauthorized(request: Request, env: Env): Response {
  return json({ error: 'Unauthorized' }, request, env, { status: 401 });
}

function notFound(request: Request, env: Env): Response {
  return json({ error: 'Not Found' }, request, env, { status: 404 });
}

function tooManyRequests(request: Request, env: Env, retryAfterSeconds: number): Response {
  const headers = corsHeaders(request, env);
  headers.set('Retry-After', String(retryAfterSeconds));
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify({ error: 'Too Many Requests' }), { status: 429, headers });
}

function getClientIp(request: Request): string | null {
  const cfIp = request.headers.get('CF-Connecting-IP');
  if (cfIp) return cfIp;
  const forwarded = request.headers.get('X-Forwarded-For');
  if (!forwarded) return null;
  const first = forwarded.split(',')[0]?.trim();
  return first || null;
}

function checkRateLimit(scope: string): { limited: false } | { limited: true; retryAfterSeconds: number } {
  const now = Date.now();
  const key = `sync:${scope}`;
  const existing = rateBuckets.get(key);
  if (!existing || existing.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { limited: false };
  }
  if (existing.count >= RATE_LIMIT_MAX_REQUESTS) {
    return { limited: true, retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)) };
  }
  existing.count += 1;
  if (rateBuckets.size > 5000) {
    for (const [bucketKey, bucket] of rateBuckets) {
      if (bucket.resetAt <= now) rateBuckets.delete(bucketKey);
    }
  }
  return { limited: false };
}

// Parse /sync/{roomId}/blocks/{cid} or /sync/{roomId}/meta
const BLOCK_RE = /^\/sync\/([0-9a-f]{64})\/blocks\/([A-Za-z0-9_-]+)$/;
const META_RE  = /^\/sync\/([0-9a-f]{64})\/meta$/;
const ROOM_RE  = /^\/sync\/([0-9a-f]{64})$/;

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    const url = new URL(request.url);
    const { pathname } = url;

    // Health
    if (pathname === '/health') {
      return json({ ok: true, service: 'boomerang-sync' }, request, env);
    }

    // POST /sync/room — create room
    if (pathname === '/sync/room' && request.method === 'POST') {
      const clientIp = getClientIp(request);
      const limited = clientIp ? checkRateLimit(`client:${clientIp}`) : { limited: false as const };
      if (limited.limited) return tooManyRequests(request, env, limited.retryAfterSeconds);
      const { roomId, token } = await createRoom(env.SYNC_BLOCKS);
      return json({ roomId, token }, request, env, { status: 201 });
    }

    // Block routes: /sync/{roomId}/blocks/{cid}
    const blockMatch = pathname.match(BLOCK_RE);
    if (blockMatch) {
      const [, roomId, cid] = blockMatch;

      if (request.method === 'GET') {
        const limited = checkRateLimit(`room:${roomId}`);
        if (limited.limited) return tooManyRequests(request, env, limited.retryAfterSeconds);
        const obj = await env.SYNC_BLOCKS.get(`${roomId}/blocks/${cid}`);
        if (!obj) return notFound(request, env);
        const headers = corsHeaders(request, env);
        headers.set('Content-Type', 'application/octet-stream');
        headers.set('Cache-Control', 'public, max-age=31536000, immutable');
        return new Response(obj.body, { headers });
      }

      if (request.method === 'PUT') {
        const limited = checkRateLimit(`room:${roomId}`);
        if (limited.limited) return tooManyRequests(request, env, limited.retryAfterSeconds);
        const token = extractBearer(request);
        if (!token || !(await verifyToken(env.SYNC_BLOCKS, roomId, token))) {
          return unauthorized(request, env);
        }
        // Skip if already exists (dedup, saves R2 write quota)
        const existing = await env.SYNC_BLOCKS.head(`${roomId}/blocks/${cid}`);
        if (existing) {
          return new Response(null, { status: 204, headers: corsHeaders(request, env) });
        }
        await env.SYNC_BLOCKS.put(`${roomId}/blocks/${cid}`, request.body);
        return new Response(null, { status: 201, headers: corsHeaders(request, env) });
      }
    }

    // Meta routes: /sync/{roomId}/meta
    const metaMatch = pathname.match(META_RE);
    if (metaMatch) {
      const [, roomId] = metaMatch;

      if (request.method === 'GET') {
        const limited = checkRateLimit(`room:${roomId}`);
        if (limited.limited) return tooManyRequests(request, env, limited.retryAfterSeconds);
        const obj = await env.SYNC_BLOCKS.get(`${roomId}/meta`);
        if (!obj) return notFound(request, env);
        const headers = corsHeaders(request, env);
        headers.set('Content-Type', 'application/json; charset=utf-8');
        if (obj.etag) headers.set('ETag', obj.etag);
        return new Response(obj.body, { headers });
      }

      if (request.method === 'PUT') {
        const limited = checkRateLimit(`room:${roomId}`);
        if (limited.limited) return tooManyRequests(request, env, limited.retryAfterSeconds);
        const token = extractBearer(request);
        if (!token || !(await verifyToken(env.SYNC_BLOCKS, roomId, token))) {
          return unauthorized(request, env);
        }
        // ETag conflict guard
        const ifMatch = request.headers.get('If-Match');
        if (ifMatch) {
          const current = await env.SYNC_BLOCKS.head(`${roomId}/meta`);
          if (current && current.etag !== ifMatch) {
            return new Response(null, { status: 412, headers: corsHeaders(request, env) });
          }
        }
        const body = await request.text();
        await env.SYNC_BLOCKS.put(`${roomId}/meta`, body, {
          httpMetadata: { contentType: 'application/json' },
        });
        return new Response(null, { status: 200, headers: corsHeaders(request, env) });
      }
    }

    // DELETE /sync/{roomId} — revoke room
    const roomMatch = pathname.match(ROOM_RE);
    if (roomMatch && request.method === 'DELETE') {
      const [, roomId] = roomMatch;
      const limited = checkRateLimit(`room:${roomId}`);
      if (limited.limited) return tooManyRequests(request, env, limited.retryAfterSeconds);
      const token = extractBearer(request);
      if (!token || !(await verifyToken(env.SYNC_BLOCKS, roomId, token))) {
        return unauthorized(request, env);
      }
      await deleteRoom(env.SYNC_BLOCKS, roomId);
      return new Response(null, { status: 200, headers: corsHeaders(request, env) });
    }

    return notFound(request, env);
  },
} satisfies ExportedHandler<Env>;
