import { DEFAULT_SOURCES, SOURCE_BY_ID, type NewsSource } from './sources';
import { fetchFeedsStaggered } from './rssFetch';
import { extractOgImageFromHtml, isAllowedOgFetchUrl } from './ogImage';

/** Production + explicit dev URLs. Local Vite may use any port — see `isAllowedOrigin`. */
const ALLOWED_ORIGINS = [
  'https://victusfate.github.io',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
];

const BUNDLE_CACHE_TTL_SEC = 300;
/** Hotlinked images via GET /image — cache longer than JSON. */
const IMAGE_PROXY_CACHE_TTL_SEC = 86_400;

function isAllowedOrigin(origin: string): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:') return false;
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function corsHeaders(request: Request): Headers {
  const origin = request.headers.get('Origin') ?? '';
  const allow = isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0];
  const h = new Headers();
  h.set('Access-Control-Allow-Origin', allow);
  h.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  h.set('Vary', 'Origin');
  return h;
}

function json(data: unknown, request: Request, init?: ResponseInit): Response {
  const headers = corsHeaders(request);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', `public, max-age=${BUNDLE_CACHE_TTL_SEC}`);
  return new Response(JSON.stringify(data), { ...init, headers });
}

function resolveSources(searchParams: URLSearchParams): NewsSource[] {
  const include = searchParams.get('include');
  if (!include || include.trim() === '') {
    return DEFAULT_SOURCES.filter(s => s.enabled);
  }
  const ids = include.split(',').map(s => s.trim()).filter(Boolean);
  const out: NewsSource[] = [];
  for (const id of ids) {
    const src = SOURCE_BY_ID.get(id);
    if (src) out.push(src);
  }
  return out;
}

export default {
  async fetch(request: Request, _env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'boomerang-rss' }, request);
    }

    if (url.pathname === '/bundle' && request.method === 'GET') {
      const cacheKey = new Request(url.toString(), { method: 'GET' });
      const cache = caches.default;
      const cached = await cache.match(cacheKey);
      if (cached) {
        const h = new Headers(cached.headers);
        const cors = corsHeaders(request);
        cors.forEach((v, k) => h.set(k, v));
        return new Response(cached.body, { status: cached.status, headers: h });
      }

      const sources = resolveSources(url.searchParams);
      if (sources.length === 0) {
        return json(
          {
            ok: false,
            message: 'No valid sources in include=',
            articles: [],
            errors: [],
            fetchedAt: Date.now(),
          },
          request,
          { status: 400 },
        );
      }

      const { articles, errors } = await fetchFeedsStaggered(sources);
      const body = {
        ok: true,
        articles,
        errors,
        partial: errors.length > 0,
        fetchedAt: Date.now(),
      };

      const response = json(body, request);
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    }

    /** Lazy card images: fetch article HTML in the Worker (no browser CORS) and return og:image URL. */
    if (url.pathname === '/og-image' && request.method === 'GET') {
      const target = url.searchParams.get('url');
      if (!target || !isAllowedOgFetchUrl(target)) {
        return json({ imageUrl: null }, request, { status: 400 });
      }

      const cacheKey = new Request(url.toString(), { method: 'GET' });
      const cache = caches.default;
      const cached = await cache.match(cacheKey);
      if (cached) {
        const h = new Headers(cached.headers);
        const cors = corsHeaders(request);
        cors.forEach((v, k) => h.set(k, v));
        return new Response(cached.body, { status: cached.status, headers: h });
      }

      let html: string;
      try {
        const upstream = await fetch(target, {
          redirect: 'follow',
          headers: { 'User-Agent': 'BoomerangRSS/1.0 (og-image; +https://github.com/victusfate/boomerang)' },
        });
        if (!upstream.ok) {
          return json({ imageUrl: null }, request, { status: 502 });
        }
        html = await upstream.text();
      } catch {
        return json({ imageUrl: null }, request, { status: 502 });
      }

      const resolved = extractOgImageFromHtml(html, target);
      const body = { imageUrl: resolved ?? null };
      const response = json(body, request);
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    }

    /**
     * Optional image proxy: GET /image?url=… — same-origin + CORS for the news app when a host blocks hotlinking.
     * Returns upstream bytes with Content-Type; rejects obvious HTML responses.
     */
    if (url.pathname === '/image' && request.method === 'GET') {
      const target = url.searchParams.get('url');
      if (!target || !isAllowedOgFetchUrl(target)) {
        return new Response('Bad Request', { status: 400, headers: corsHeaders(request) });
      }

      const cacheKey = new Request(url.toString(), { method: 'GET' });
      const cache = caches.default;
      const cached = await cache.match(cacheKey);
      if (cached) {
        const h = new Headers(cached.headers);
        const cors = corsHeaders(request);
        cors.forEach((v, k) => h.set(k, v));
        return new Response(cached.body, { status: cached.status, headers: h });
      }

      let upstream: Response;
      try {
        upstream = await fetch(target, {
          redirect: 'follow',
          headers: { 'User-Agent': 'BoomerangRSS/1.0 (image-proxy; +https://github.com/victusfate/boomerang)' },
        });
      } catch {
        return new Response(null, { status: 502, headers: corsHeaders(request) });
      }

      if (!upstream.ok) {
        return new Response(null, { status: 502, headers: corsHeaders(request) });
      }

      const mime = upstream.headers.get('Content-Type') ?? '';
      if (mime.includes('text/html')) {
        return new Response(null, { status: 422, headers: corsHeaders(request) });
      }

      const out = new Headers(corsHeaders(request));
      const ct = mime.startsWith('image/') ? mime : (mime || 'application/octet-stream');
      out.set('Content-Type', ct);
      out.set('Cache-Control', `public, max-age=${IMAGE_PROXY_CACHE_TTL_SEC}`);
      const res = new Response(upstream.body, { status: 200, headers: out });
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders(request) });
  },
} satisfies ExportedHandler<Env>;
