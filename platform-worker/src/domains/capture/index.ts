import type { Env } from '../../env.ts';
import { corsHeaders } from '../../cors.ts';
import { extractBearer, verifyToken } from '../sync/auth.ts';
import { generateCaptureToken, resolveCaptureToken, revokeCaptureToken } from './token.ts';
import { checkCaptureRateLimit } from './rateLimit.ts';
import { normalizeBody } from './normalize.ts';
import { isDuplicate, markSeen } from './dedupe.ts';
import { appendToSavedList } from './adapter/savedList.ts';
import type { CaptureDestination } from './types.ts';
import {
  HTTP_OK,
  HTTP_NO_CONTENT,
  HTTP_BAD_REQUEST,
  HTTP_UNAUTHORIZED,
  HTTP_METHOD_NOT_ALLOWED,
  HTTP_TOO_MANY_REQUESTS,
} from '../../lib/http-status.ts';

const TOKEN_PATH = '/api/capture/token';
const INGEST_RE = /^\/api\/capture\/([^/]+)$/;
const SAVE_RE = /^\/save\/([^/]+)$/;
const BODY_MAX_BYTES = 16 * 1024;
const SAVE_NOTE_MAX = 500;

function captureResponse(status: number, retryAfterSeconds?: number): Response {
  const headers = new Headers({ 'Access-Control-Allow-Origin': '*' });
  if (retryAfterSeconds !== undefined) headers.set('Retry-After', String(retryAfterSeconds));
  return new Response(null, { status, headers });
}

function parseDestination(value: unknown): CaptureDestination | null {
  if (typeof value !== 'object' || value === null) return null;
  const dest = value as Record<string, unknown>;
  if (dest.type === 'saved-list') return { type: 'saved-list' };
  return null;
}

async function handleTokenManagement(request: Request, env: Env): Promise<Response> {
  const cors = corsHeaders(request, env);
  const reply = (status: number, payload?: unknown): Response => {
    if (payload !== undefined) cors.set('Content-Type', 'application/json; charset=utf-8');
    return new Response(payload === undefined ? null : JSON.stringify(payload), { status, headers: cors });
  };

  if (request.method !== 'POST' && request.method !== 'DELETE') return reply(HTTP_METHOD_NOT_ALLOWED);

  const bearer = extractBearer(request);
  if (!bearer) return reply(HTTP_UNAUTHORIZED);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return reply(HTTP_BAD_REQUEST);
  }
  const roomId = body.roomId;
  if (typeof roomId !== 'string') return reply(HTTP_BAD_REQUEST);

  if (!(await verifyToken(env.SYNC_BLOCKS, roomId, bearer))) return reply(HTTP_UNAUTHORIZED);

  if (request.method === 'DELETE') {
    await revokeCaptureToken(env.CAPTURE_TOKENS, roomId);
    return reply(HTTP_NO_CONTENT);
  }

  const destination = parseDestination(body.destination);
  if (!destination) return reply(HTTP_BAD_REQUEST);
  const { captureToken } = await generateCaptureToken(env.CAPTURE_TOKENS, roomId, destination);
  return reply(HTTP_OK, { captureToken });
}

/**
 * The shared capture pipeline: resolve token → rate-limit → size-guard →
 * normalize → dedupe → dispatch. Returns a bare status (plus retry hint) so each
 * entry point can shape its own response — `captureResponse` for the JSON/204
 * `POST` path, an HTML page for the `GET /save` popup path.
 */
async function runCapture(
  env: Env,
  tokenId: string,
  raw: string,
): Promise<{ status: number; retryAfterSeconds?: number }> {
  const tag = tokenId.slice(0, 8);
  const record = await resolveCaptureToken(env.CAPTURE_TOKENS, tokenId);
  if (!record) {
    console.warn(`capture[${tag}]: rejected 401 — unknown or revoked token`);
    return { status: HTTP_UNAUTHORIZED };
  }

  const rate = await checkCaptureRateLimit(env.CAPTURE_TOKENS, tokenId);
  if (rate.limited) {
    console.warn(`capture[${tag}]: rejected 429 — rate limited, retry after ${rate.retryAfterSeconds}s`);
    return { status: HTTP_TOO_MANY_REQUESTS, retryAfterSeconds: rate.retryAfterSeconds };
  }

  if (new TextEncoder().encode(raw).length > BODY_MAX_BYTES) {
    console.warn(`capture[${tag}]: rejected 400 — body exceeds ${BODY_MAX_BYTES} bytes`);
    return { status: HTTP_BAD_REQUEST };
  }

  const capture = normalizeBody(raw);
  if (!capture) {
    console.warn(`capture[${tag}]: rejected 400 — invalid body or non-http(s) URL`);
    return { status: HTTP_BAD_REQUEST };
  }

  if (await isDuplicate(env.CAPTURE_TOKENS, tokenId, capture.url)) {
    console.log(`capture[${tag}]: dropped 204 — duplicate within dedupe window: ${capture.url}`);
    return { status: HTTP_NO_CONTENT };
  }
  await markSeen(env.CAPTURE_TOKENS, tokenId, capture.url);

  await appendToSavedList(env.SYNC_BLOCKS, record.roomId, capture);

  console.log(`capture[${tag}]: saved 204 → ${record.destinationType}: ${capture.url}`);
  return { status: HTTP_NO_CONTENT };
}

/**
 * HTML confirmation page for the bookmarklet popup. A successful save (internal
 * 204) renders as 200 and auto-closes the popup; failures render their status
 * with the reason so the user sees why nothing was saved.
 */
function savePage(outcomeStatus: number): Response {
  const ok = outcomeStatus === HTTP_NO_CONTENT;
  const status = ok ? HTTP_OK : outcomeStatus;
  const message = ok
    ? 'Saved to boomerang'
    : outcomeStatus === HTTP_TOO_MANY_REQUESTS
      ? 'Rate limited — try again in a bit'
      : outcomeStatus === HTTP_UNAUTHORIZED
        ? 'Capture token invalid or revoked'
        : 'Page not saveable';
  const bg = ok ? '#16a34a' : '#dc2626';
  const closeScript = ok ? '<script>setTimeout(function(){window.close();},800);</script>' : '';
  const html =
    '<!doctype html><html><head><meta charset="utf-8"><title>boomerang</title></head>' +
    `<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;` +
    `font:600 16px system-ui,sans-serif;background:${bg};color:#fff">${message}${closeScript}</body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

export async function handleCapture(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === TOKEN_PATH) return handleTokenManagement(request, env);

  const ingestMatch = path.match(INGEST_RE);
  if (ingestMatch) {
    if (request.method !== 'POST') return captureResponse(HTTP_METHOD_NOT_ALLOWED);
    const outcome = await runCapture(env, ingestMatch[1], await request.text());
    return captureResponse(outcome.status, outcome.retryAfterSeconds);
  }

  const saveMatch = path.match(SAVE_RE);
  if (saveMatch) {
    if (request.method !== 'GET') return captureResponse(HTTP_METHOD_NOT_ALLOWED);
    const q = url.searchParams;
    const raw = JSON.stringify({
      url: q.get('u') ?? '',
      title: q.get('ti') ?? '',
      note: (q.get('n') ?? '').slice(0, SAVE_NOTE_MAX),
      source: 'bookmarklet',
    });
    const outcome = await runCapture(env, saveMatch[1], raw);
    return savePage(outcome.status);
  }

  return captureResponse(HTTP_BAD_REQUEST);
}
