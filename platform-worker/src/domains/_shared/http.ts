import type { Env } from '../../env';
import { corsHeaders } from '../../cors';

const RATE_LIMIT_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

export function json(data: unknown, request: Request, env: Env, init?: ResponseInit, cacheMaxAge?: number): Response {
  const headers = corsHeaders(request, env);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  if (cacheMaxAge !== undefined) headers.set('Cache-Control', `public, max-age=${cacheMaxAge}`);
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function tooManyRequests(request: Request, env: Env, retryAfterSeconds: number): Response {
  const headers = corsHeaders(request, env);
  headers.set('Retry-After', String(retryAfterSeconds));
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(
    JSON.stringify({ ok: false, message: 'Too Many Requests' }),
    { status: 429, headers },
  );
}

export function getClientIp(request: Request): string | null {
  return request.headers.get('CF-Connecting-IP');
}

export function checkRateLimit(
  request: Request,
  key: string,
  max: number,
): { limited: false } | { limited: true; retryAfterSeconds: number } {
  const clientIp = getClientIp(request);
  if (!clientIp) return { limited: false };
  return checkRateLimitByKey(`${key}:${clientIp}`, max);
}

/** Rate limit on an arbitrary bucket key (e.g. per sync room rather than per IP). */
export function checkRateLimitByKey(
  bucketKey: string,
  max: number,
): { limited: false } | { limited: true; retryAfterSeconds: number } {
  const now = Date.now();
  const existing = rateBuckets.get(bucketKey);
  if (!existing || existing.resetAt <= now) {
    rateBuckets.set(bucketKey, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { limited: false };
  }
  if (existing.count >= max) {
    return { limited: true, retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)) };
  }
  existing.count += 1;
  if (rateBuckets.size > 10_000) {
    for (const [k, bucket] of rateBuckets) {
      if (bucket.resetAt <= now) rateBuckets.delete(k);
    }
  }
  return { limited: false };
}
