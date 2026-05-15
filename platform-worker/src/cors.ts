import type { Env } from './env';
import { BOOMERANG_ALLOWED_CORS_ORIGINS } from './corsOrigins';

export function isAllowedOrigin(origin: string, env: Env): boolean {
  if (!origin) return false;
  if (BOOMERANG_ALLOWED_CORS_ORIGINS.includes(origin)) return true;
  const extra = env.EXTRA_CORS_ORIGINS?.trim().split(',').map(s => s.trim()).filter(Boolean) ?? [];
  if (extra.includes(origin)) return true;
  try {
    const u = new URL(origin);
    if (u.protocol === 'https:' && u.hostname.endsWith('.pages.dev')) return true;
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true;
  } catch { /* ignore */ }
  return false;
}

export function corsHeaders(request: Request, env: Env): Headers {
  const origin = request.headers.get('Origin') ?? '';
  const headers = new Headers();
  if (isAllowedOrigin(origin, env)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, If-Match');
    headers.set('Access-Control-Expose-Headers', 'ETag');
    headers.set('Vary', 'Origin');
  }
  return headers;
}

export function handlePreflight(request: Request, env: Env): Response | null {
  if (request.method !== 'OPTIONS') return null;
  const headers = corsHeaders(request, env);
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(null, { status: 204, headers });
}
