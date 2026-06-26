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
    console.warn(`capture[${tag}]: rejected ${HTTP_UNAUTHORIZED} — unknown or revoked token`);
    return { status: HTTP_UNAUTHORIZED };
  }

  const rate = await checkCaptureRateLimit(env.CAPTURE_TOKENS, tokenId);
  if (rate.limited) {
    console.warn(`capture[${tag}]: rejected ${HTTP_TOO_MANY_REQUESTS} — rate limited, retry after ${rate.retryAfterSeconds}s`);
    return { status: HTTP_TOO_MANY_REQUESTS, retryAfterSeconds: rate.retryAfterSeconds };
  }

  if (new TextEncoder().encode(raw).length > BODY_MAX_BYTES) {
    console.warn(`capture[${tag}]: rejected ${HTTP_BAD_REQUEST} — body exceeds ${BODY_MAX_BYTES} bytes`);
    return { status: HTTP_BAD_REQUEST };
  }

  const capture = normalizeBody(raw);
  if (!capture) {
    console.warn(`capture[${tag}]: rejected ${HTTP_BAD_REQUEST} — invalid body or non-http(s) URL`);
    return { status: HTTP_BAD_REQUEST };
  }

  if (await isDuplicate(env.CAPTURE_TOKENS, tokenId, capture.url)) {
    console.log(`capture[${tag}]: dropped ${HTTP_NO_CONTENT} — duplicate within dedupe window: ${capture.url}`);
    return { status: HTTP_NO_CONTENT };
  }
  await markSeen(env.CAPTURE_TOKENS, tokenId, capture.url);

  await appendToSavedList(env.SYNC_BLOCKS, record.roomId, capture);

  console.log(`capture[${tag}]: saved ${HTTP_NO_CONTENT} → ${record.destinationType}: ${capture.url}`);
  return { status: HTTP_NO_CONTENT };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safeDomain(rawUrl: string): string {
  try { return new URL(rawUrl).hostname; } catch { return ''; }
}

/**
 * Professional confirmation page for the bookmarklet save flow. The bookmarklet
 * navigates here directly (no popup — popup is blocked on mobile), shows the
 * outcome, then returns the user via history.back() after a short delay.
 */
function savePage(outcomeStatus: number, pageUrl: string, pageTitle: string): Response {
  const ok = outcomeStatus === HTTP_NO_CONTENT;
  const status = ok ? HTTP_OK : outcomeStatus;

  const heading = ok ? 'Saved!' : 'Not saved';
  const subtitle = ok
    ? 'Added to your reading list'
    : outcomeStatus === HTTP_TOO_MANY_REQUESTS
      ? 'Rate limited — try again in a bit'
      : outcomeStatus === HTTP_UNAUTHORIZED
        ? 'Capture token invalid or revoked'
        : 'This page could not be saved';

  const icon = ok ? '&#10003;' : '&#10007;';
  const stateClass = ok ? 'ok' : 'err';

  const titleHtml = pageTitle
    ? `<div class="mt">${escapeHtml(pageTitle.slice(0, 120))}</div>`
    : '';
  const domain = safeDomain(pageUrl);
  const domainHtml = domain ? `<div class="md">${escapeHtml(domain)}</div>` : '';
  const metaHtml = titleHtml || domainHtml
    ? `<div class="mb">${titleHtml}${domainHtml}</div>`
    : '';

  // quality-ok: magic-number — 2000 ms delay lets the user read the confirmation before auto-returning
  const autoNavScript = ok
    ? '<script>setTimeout(function(){if(history.length>1){history.back();}},2000);</script>'
    : '';

  const css =
    '*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}' +
    'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;' +
    'background:#f5f5f7;min-height:100dvh;display:flex;flex-direction:column;' +
    'align-items:center;justify-content:center;padding:24px 16px;-webkit-font-smoothing:antialiased}' +
    '.card{background:#fff;border-radius:20px;padding:32px 28px;max-width:380px;width:100%;' +
    'box-shadow:0 2px 12px rgba(0,0,0,.06),0 8px 32px rgba(0,0,0,.06);text-align:center}' +
    '.brand{font-size:11px;font-weight:700;color:#9ca3af;letter-spacing:.12em;text-transform:uppercase;margin-bottom:28px}' +
    '.ic{width:52px;height:52px;border-radius:50%;margin:0 auto 16px;' +
    'display:flex;align-items:center;justify-content:center;font-size:24px;line-height:1}' +
    '.ok .ic{background:#f0fdf4;color:#16a34a}' +
    '.err .ic{background:#fef2f2;color:#dc2626}' +
    'h1{font-size:20px;font-weight:700;letter-spacing:-.3px;margin-bottom:6px}' +
    '.ok h1{color:#15803d}.err h1{color:#b91c1c}' +
    '.sub{font-size:14px;color:#6b7280;margin-bottom:20px;line-height:1.5}' +
    '.mb{background:#f9fafb;border:1px solid #f0f0f0;border-radius:12px;padding:14px 16px;text-align:left;margin-bottom:0}' +
    '.mt{font-size:14px;font-weight:600;color:#111827;overflow:hidden;' +
    'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;margin-bottom:4px;line-height:1.4}' +
    '.md{font-size:12px;color:#9ca3af;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    'button{display:block;width:100%;margin-top:20px;padding:11px 20px;background:#111827;' +
    'color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;letter-spacing:-.1px}' +
    'button:active{opacity:.8}';

  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>Boomerang</title><style>${css}</style></head><body>` +
    `<div class="card ${stateClass}">` +
    '<div class="brand">Boomerang</div>' +
    `<div class="ic">${icon}</div>` +
    `<h1>${heading}</h1>` +
    `<p class="sub">${subtitle}</p>` +
    `${metaHtml}` +
    '<button onclick="history.back()">&#8592; Go back</button>' +
    `</div>${autoNavScript}</body></html>`;

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
    const pageUrl = q.get('u') ?? '';
    const pageTitle = q.get('ti') ?? '';
    const raw = JSON.stringify({
      url: pageUrl,
      title: pageTitle,
      note: (q.get('n') ?? '').slice(0, SAVE_NOTE_MAX),
      source: 'bookmarklet',
    });
    const outcome = await runCapture(env, saveMatch[1], raw);
    return savePage(outcome.status, pageUrl, pageTitle);
  }

  return captureResponse(HTTP_BAD_REQUEST);
}
