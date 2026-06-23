import type { Env } from '../../env.ts';
import { resolveCaptureToken } from './token.ts';
import { checkCaptureRateLimit } from './rateLimit.ts';
import { normalizeBody } from './normalize.ts';
import {
  HTTP_NO_CONTENT,
  HTTP_BAD_REQUEST,
  HTTP_UNAUTHORIZED,
  HTTP_METHOD_NOT_ALLOWED,
  HTTP_TOO_MANY_REQUESTS,
} from '../../lib/http-status.ts';

const INGEST_RE = /^\/api\/capture\/([^/]+)$/;
const BODY_MAX_BYTES = 16 * 1024;

function captureResponse(status: number, retryAfterSeconds?: number): Response {
  const headers = new Headers({ 'Access-Control-Allow-Origin': '*' });
  if (retryAfterSeconds !== undefined) headers.set('Retry-After', String(retryAfterSeconds));
  return new Response(null, { status, headers });
}

export async function handleCapture(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const path = new URL(request.url).pathname;
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

  return captureResponse(HTTP_NO_CONTENT);
}
