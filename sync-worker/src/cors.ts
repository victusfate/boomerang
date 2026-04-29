const ALLOWED_ORIGINS = [
  'https://victusfate.github.io',
  'https://boomerang-news.com',
  'https://www.boomerang-news.com',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

export function isAllowedOrigin(origin: string, env: Env): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  const extra = env.EXTRA_CORS_ORIGINS?.trim();
  if (extra && extra.split(',').map(s => s.trim()).includes(origin)) return true;
  try {
    const u = new URL(origin);
    if (u.protocol === 'https:' && u.hostname.endsWith('.pages.dev')) return true;
    if (u.protocol !== 'http:') return false;
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

export function corsHeaders(request: Request, env: Env): Headers {
  const origin = request.headers.get('Origin') ?? '';
  const allow = isAllowedOrigin(origin, env) ? origin : ALLOWED_ORIGINS[0];
  const h = new Headers();
  h.set('Access-Control-Allow-Origin', allow);
  h.set('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  h.set('Vary', 'Origin');
  return h;
}
