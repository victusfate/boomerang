import { corsHeaders } from './cors';
import { createRoom, deleteRoom } from './room';
import { verifyToken, extractBearer } from './auth';

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

// Parse /sync/{roomId}/blocks/{cid} or /sync/{roomId}/meta
const BLOCK_RE = /^\/sync\/([0-9a-f]{64})\/blocks\/([A-Za-z0-9_-]+)$/;
const META_RE  = /^\/sync\/([0-9a-f]{64})\/meta$/;
const ROOM_RE  = /^\/sync\/([0-9a-f]{64})$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
      const { roomId, token } = await createRoom(env.SYNC_BLOCKS);
      return json({ roomId, token }, request, env, { status: 201 });
    }

    // Block routes: /sync/{roomId}/blocks/{cid}
    const blockMatch = pathname.match(BLOCK_RE);
    if (blockMatch) {
      const [, roomId, cid] = blockMatch;

      if (request.method === 'GET') {
        const obj = await env.SYNC_BLOCKS.get(`${roomId}/blocks/${cid}`);
        if (!obj) return notFound(request, env);
        const headers = corsHeaders(request, env);
        headers.set('Content-Type', 'application/octet-stream');
        headers.set('Cache-Control', 'public, max-age=31536000, immutable');
        return new Response(obj.body, { headers });
      }

      if (request.method === 'PUT') {
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
        const obj = await env.SYNC_BLOCKS.get(`${roomId}/meta`);
        if (!obj) return notFound(request, env);
        const headers = corsHeaders(request, env);
        headers.set('Content-Type', 'application/json; charset=utf-8');
        if (obj.etag) headers.set('ETag', obj.etag);
        return new Response(obj.body, { headers });
      }

      if (request.method === 'PUT') {
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
