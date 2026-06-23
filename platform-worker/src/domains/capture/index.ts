import type { Env } from '../../env.ts';
import { corsHeaders } from '../../cors.ts';
import { extractBearer, verifyToken } from '../sync/auth.ts';
import { generateCaptureToken, resolveCaptureToken, revokeCaptureToken } from './token.ts';
import { checkCaptureRateLimit } from './rateLimit.ts';
import { normalizeBody } from './normalize.ts';
import { isDuplicate, markSeen } from './dedupe.ts';
import { appendToSavedList } from './adapter/savedList.ts';
import { appendToGithub } from './adapter/github.ts';
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
const BODY_MAX_BYTES = 16 * 1024;

function captureResponse(status: number, retryAfterSeconds?: number): Response {
  const headers = new Headers({ 'Access-Control-Allow-Origin': '*' });
  if (retryAfterSeconds !== undefined) headers.set('Retry-After', String(retryAfterSeconds));
  return new Response(null, { status, headers });
}

function parseDestination(value: unknown): CaptureDestination | null {
  if (typeof value !== 'object' || value === null) return null;
  const dest = value as Record<string, unknown>;
  if (dest.type === 'saved-list') return { type: 'saved-list' };
  if (dest.type === 'github') {
    const { owner, repo, path, branch } = dest;
    if ([owner, repo, path, branch].every(f => typeof f === 'string' && f)) {
      return { type: 'github', owner, repo, path, branch } as CaptureDestination;
    }
  }
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

export async function handleCapture(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === TOKEN_PATH) return handleTokenManagement(request, env);

  const match = path.match(INGEST_RE);
  if (!match) return captureResponse(HTTP_BAD_REQUEST);

  if (request.method !== 'POST') return captureResponse(HTTP_METHOD_NOT_ALLOWED);

  const tokenId = match[1];
  const record = await resolveCaptureToken(env.CAPTURE_TOKENS, tokenId);
  if (!record) return captureResponse(HTTP_UNAUTHORIZED);

  const rate = await checkCaptureRateLimit(env.CAPTURE_TOKENS, tokenId);
  if (rate.limited) return captureResponse(HTTP_TOO_MANY_REQUESTS, rate.retryAfterSeconds);

  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > BODY_MAX_BYTES) return captureResponse(HTTP_BAD_REQUEST);

  const capture = normalizeBody(raw);
  if (!capture) return captureResponse(HTTP_BAD_REQUEST);

  if (await isDuplicate(env.CAPTURE_TOKENS, tokenId, capture.url)) {
    return captureResponse(HTTP_NO_CONTENT);
  }
  await markSeen(env.CAPTURE_TOKENS, tokenId, capture.url);

  if (record.destinationType === 'saved-list') {
    await appendToSavedList(env.SYNC_BLOCKS, record.roomId, capture);
  } else if (record.destinationType === 'github' && env.GITHUB_PAT) {
    ctx.waitUntil(appendToGithub(fetch, env.GITHUB_PAT, record.destinationConfig, capture));
  }

  return captureResponse(HTTP_NO_CONTENT);
}
