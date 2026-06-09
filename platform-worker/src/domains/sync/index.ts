import type { Env } from '../../env';
import { corsHeaders } from '../../cors';
import { json, getClientIp, checkRateLimitByKey, tooManyRequests } from '../_shared/http';
import { createRoom, deleteRoom } from './room';
import { verifyToken, extractBearer } from './auth';

const RATE_LIMIT_MAX_REQUESTS = 30;

function unauthorized(request: Request, env: Env): Response {
  return json({ error: 'Unauthorized' }, request, env, { status: 401 });
}

function notFound(request: Request, env: Env): Response {
  return json({ error: 'Not Found' }, request, env, { status: 404 });
}

function checkRateLimit(scope: string): { limited: false } | { limited: true; retryAfterSeconds: number } {
  return checkRateLimitByKey(`sync:${scope}`, RATE_LIMIT_MAX_REQUESTS);
}

/** Bound buffered upload sizes — sync payloads are small prefs/article docs. */
const MAX_SYNC_BODY_BYTES = 4 * 1024 * 1024;

function bodyTooLarge(request: Request): boolean {
  const cl = parseInt(request.headers.get('Content-Length') ?? '0', 10);
  return Number.isFinite(cl) && cl > MAX_SYNC_BODY_BYTES;
}

const BLOCK_RE = /^\/sync\/([0-9a-f]{64})\/blocks\/([A-Za-z0-9_-]+)$/;
const META_RE  = /^\/sync\/([0-9a-f]{64})\/meta$/;
const ROOM_RE  = /^\/sync\/([0-9a-f]{64})$/;

export async function handleSync(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;

  if (pathname === '/sync/room' && request.method === 'POST') {
    const clientIp = getClientIp(request);
    const limited = clientIp ? checkRateLimit(`client:${clientIp}`) : { limited: false as const };
    if (limited.limited) return tooManyRequests(request, env, limited.retryAfterSeconds);
    const { roomId, token } = await createRoom(env.SYNC_BLOCKS);
    return json({ roomId, token }, request, env, { status: 201 });
  }

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
      // Auth before rate-limit: reject invalid tokens without consuming quota.
      const token = extractBearer(request);
      if (!token || !(await verifyToken(env.SYNC_BLOCKS, roomId, token))) {
        return unauthorized(request, env);
      }
      const limited = checkRateLimit(`room:${roomId}`);
      if (limited.limited) return tooManyRequests(request, env, limited.retryAfterSeconds);
      if (bodyTooLarge(request)) {
        return json({ error: 'Payload Too Large' }, request, env, { status: 413 });
      }
      const existing = await env.SYNC_BLOCKS.head(`${roomId}/blocks/${cid}`);
      if (existing) {
        return new Response(null, { status: 204, headers: corsHeaders(request, env) });
      }
      await env.SYNC_BLOCKS.put(`${roomId}/blocks/${cid}`, request.body);
      return new Response(null, { status: 201, headers: corsHeaders(request, env) });
    }
  }

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
      // Auth before rate-limit: reject invalid tokens without consuming quota.
      const token = extractBearer(request);
      if (!token || !(await verifyToken(env.SYNC_BLOCKS, roomId, token))) {
        return unauthorized(request, env);
      }
      const limited = checkRateLimit(`room:${roomId}`);
      if (limited.limited) return tooManyRequests(request, env, limited.retryAfterSeconds);
      if (bodyTooLarge(request)) {
        return json({ error: 'Payload Too Large' }, request, env, { status: 413 });
      }
      const ifMatch = request.headers.get('If-Match');
      const body = await request.text();
      if (ifMatch) {
        // Atomic conditional write — a head-then-put check is a TOCTOU window
        // where two concurrent PUTs both pass and silently last-write-win.
        const put = await env.SYNC_BLOCKS.put(`${roomId}/meta`, body, {
          httpMetadata: { contentType: 'application/json' },
          onlyIf: { etagMatches: ifMatch },
        });
        if (put === null) {
          return new Response(null, { status: 412, headers: corsHeaders(request, env) });
        }
        return new Response(null, { status: 200, headers: corsHeaders(request, env) });
      }
      await env.SYNC_BLOCKS.put(`${roomId}/meta`, body, {
        httpMetadata: { contentType: 'application/json' },
      });
      return new Response(null, { status: 200, headers: corsHeaders(request, env) });
    }
  }

  const roomMatch = pathname.match(ROOM_RE);
  if (roomMatch && request.method === 'DELETE') {
    const [, roomId] = roomMatch;
    // Auth before rate-limit: reject invalid tokens without consuming quota.
    const token = extractBearer(request);
    if (!token || !(await verifyToken(env.SYNC_BLOCKS, roomId, token))) {
      return unauthorized(request, env);
    }
    const limited = checkRateLimit(`room:${roomId}`);
    if (limited.limited) return tooManyRequests(request, env, limited.retryAfterSeconds);
    await deleteRoom(env.SYNC_BLOCKS, roomId);
    return new Response(null, { status: 200, headers: corsHeaders(request, env) });
  }

  return notFound(request, env);
}
