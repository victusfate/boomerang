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
/** Max bytes to buffer when fetching article HTML for og:image extraction. */
const MAX_HTML_BYTES = 1 * 1024 * 1024; // 1 MB
/** Max bytes to proxy for images — rejects oversized upstream responses. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

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

/** Parse `customFeeds` base64 param — returns only SSRF-safe https:// URLs. */
function resolveCustomSources(searchParams: URLSearchParams): NewsSource[] {
  const param = searchParams.get('customFeeds');
  if (!param) return [];
  try {
    const binary = atob(param);
    const bytes = Uint8Array.from(binary, (c: string) => c.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);
    const raw = JSON.parse(json) as Array<{ id?: unknown; name?: unknown; feedUrl?: unknown }>;
    if (!Array.isArray(raw)) return [];
    const out: NewsSource[] = [];
    for (const item of raw) {
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      const feedUrl = typeof item.feedUrl === 'string' ? item.feedUrl.trim() : '';
      if (!id || !name || !feedUrl) continue;
      if (!isAllowedOgFetchUrl(feedUrl)) continue; // SSRF protection
      out.push({ id: `custom-${id}`, name, feedUrl, category: 'general', enabled: true });
    }
    return out;
  } catch {
    return [];
  }
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
      const customSources = resolveCustomSources(url.searchParams);
      if (sources.length === 0 && customSources.length === 0) {
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

      const { articles, errors } = await fetchFeedsStaggered([...sources, ...customSources]);
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
          headers: {
            'User-Agent':
              'Mozilla/5.0 (compatible; BoomerangRSS/1.0; +https://github.com/victusfate/boomerang) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        });
        if (!upstream.ok) {
          return json({ imageUrl: null }, request, { status: 502 });
        }
        const cl = parseInt(upstream.headers.get('Content-Length') ?? '0', 10);
        if (cl > MAX_HTML_BYTES) return json({ imageUrl: null }, request, { status: 413 });
        const buf = await upstream.arrayBuffer();
        if (buf.byteLength > MAX_HTML_BYTES) return json({ imageUrl: null }, request, { status: 413 });
        html = new TextDecoder().decode(buf);
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
      const imgCl = parseInt(upstream.headers.get('Content-Length') ?? '0', 10);
      if (imgCl > MAX_IMAGE_BYTES) {
        return new Response(null, { status: 413, headers: corsHeaders(request) });
      }
      const imgBuf = await upstream.arrayBuffer();
      if (imgBuf.byteLength > MAX_IMAGE_BYTES) {
        return new Response(null, { status: 413, headers: corsHeaders(request) });
      }

      const out = new Headers(corsHeaders(request));
      const ct = mime.startsWith('image/') ? mime : (mime || 'application/octet-stream');
      out.set('Content-Type', ct);
      out.set('Cache-Control', `public, max-age=${IMAGE_PROXY_CACHE_TTL_SEC}`);
      const res = new Response(imgBuf, { status: 200, headers: out });
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders(request) });
  },
} satisfies ExportedHandler<Env>;
