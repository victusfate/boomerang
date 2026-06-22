import type { Env } from '../../env';
import { corsHeaders } from '../../cors';
import { checkRateLimit, tooManyRequests } from '../_shared/http';
import { HTTP_OK, HTTP_REDIRECT_MIN, HTTP_BAD_REQUEST, HTTP_PAYLOAD_TOO_LARGE } from '../../lib/http-status.js';
import { DEFAULT_SOURCES, SOURCE_BY_ID, type NewsSource } from './sources';
import { fetchFeedsStaggered } from './rssFetch';
import { extractOgImageFromHtml, isAllowedOgFetchUrl } from './ogImage';
import { persistArticleMeta, wireArticleFromFeed } from '../rec/articleMeta';

const BUNDLE_CACHE_TTL_SEC = 300;
const IMAGE_PROXY_CACHE_TTL_SEC = 86_400;
const BYTES_PER_MB = 1024 * 1024;
const MAX_HTML_MB = 1;
const MAX_IMAGE_MB = 10;
const MAX_HTML_BYTES = MAX_HTML_MB * BYTES_PER_MB;
const MAX_IMAGE_BYTES = MAX_IMAGE_MB * BYTES_PER_MB;
/** Custom feeds are attacker-controllable URLs — cap the fan-out per request. */
const MAX_CUSTOM_FEEDS = 20;
const RATE_LIMIT_BUNDLE_MAX = 30; // per IP per minute
const UPSTREAM_FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECT_HOPS = 3;

/** Replay a cached response with CORS for the *current* request — never the cached origin's. */
function replayCached(cached: Response, request: Request, env: Env): Response {
  const h = new Headers(cached.headers);
  h.delete('Access-Control-Allow-Origin');
  h.delete('Access-Control-Allow-Credentials');
  corsHeaders(request, env).forEach((v, k) => h.set(k, v));
  return new Response(cached.body, { status: cached.status, headers: h });
}

/**
 * Fetch with manual redirect following: every hop is re-validated against the
 * SSRF allowlist (apiRoutes.ts documents this guarantee) and bounded by a timeout.
 * Returns null when a hop is disallowed or the redirect chain is too deep.
 */
async function fetchValidated(target: string, headers: Record<string, string>): Promise<Response | null> {
  let current = target;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    if (!isAllowedOgFetchUrl(current)) return null;
    const res = await fetch(current, {
      redirect: 'manual',
      headers,
      signal: AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS),
    });
    if (res.status >= HTTP_REDIRECT_MIN && res.status < HTTP_BAD_REQUEST) {
      const loc = res.headers.get('Location');
      if (!loc) return null;
      try {
        current = new URL(loc, current).href;
      } catch {
        return null;
      }
      continue;
    }
    return res;
  }
  return null;
}

function json(data: unknown, request: Request, env: Env, init?: ResponseInit, ttl = BUNDLE_CACHE_TTL_SEC): Response {
  const headers = corsHeaders(request, env);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', `public, max-age=${ttl}`);
  return new Response(JSON.stringify(data), { ...init, headers });
}

const INCLUDE_NONE_SENTINEL = '__none__';

function resolveSources(searchParams: URLSearchParams): NewsSource[] {
  const include = searchParams.get('include');
  if (include === null || include.trim() === '') {
    return DEFAULT_SOURCES.filter(s => s.enabled);
  }
  const ids = include.split(',').map(s => s.trim()).filter(Boolean);
  if (ids.length === 1 && ids[0] === INCLUDE_NONE_SENTINEL) {
    return [];
  }
  const out: NewsSource[] = [];
  for (const id of ids) {
    const src = SOURCE_BY_ID.get(id);
    if (src) out.push(src);
  }
  return out;
}

function resolveCustomSources(searchParams: URLSearchParams): NewsSource[] {
  const param = searchParams.get('customFeeds');
  if (!param) return [];
  try {
    const binary = atob(param);
    const bytes = Uint8Array.from(binary, (c: string) => c.charCodeAt(0));
    const jsonStr = new TextDecoder().decode(bytes);
    const raw = JSON.parse(jsonStr) as Array<{ id?: unknown; name?: unknown; feedUrl?: unknown }>;
    if (!Array.isArray(raw)) return [];
    const out: NewsSource[] = [];
    for (const item of raw) {
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      const feedUrl = typeof item.feedUrl === 'string' ? item.feedUrl.trim() : '';
      if (!id || !name || !feedUrl) continue;
      if (!isAllowedOgFetchUrl(feedUrl)) continue;
      out.push({ id: `custom-${id}`, name, feedUrl, category: 'general', enabled: true });
      if (out.length >= MAX_CUSTOM_FEEDS) break;
    }
    return out;
  } catch {
    return [];
  }
}

export async function handleRss(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === '/bundle' && request.method === 'GET') {
    const cacheKey = new Request(url.toString(), { method: 'GET' });
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) {
      return replayCached(cached, request, env);
    }

    // Cache misses fetch up to ~46 builtin + 20 custom feeds — rate-limit the
    // uncached path (a varying customFeeds param defeats the edge cache).
    const limited = checkRateLimit(request, 'rss-bundle', RATE_LIMIT_BUNDLE_MAX);
    if (limited.limited) return tooManyRequests(request, env, limited.retryAfterSeconds);

    const sources = resolveSources(url.searchParams);
    const customSources = resolveCustomSources(url.searchParams);
    if (sources.length === 0 && customSources.length === 0) {
      return json(
        { ok: false, message: 'No valid sources in include=', articles: [], errors: [], fetchedAt: Date.now() },
        request, env, { status: HTTP_BAD_REQUEST },
      );
    }

    const { articles, errors } = await fetchFeedsStaggered([...sources, ...customSources]);
    const body = { ok: true, articles, errors, partial: errors.length > 0, fetchedAt: Date.now() };

    const response = json(body, request, env);
    ctx.waitUntil(
      cache.put(cacheKey, response.clone()).catch(() => { /* ignore transient cache failures */ }),
    );
    // Populate REC_STORE so /rec/articles can resolve titles without re-fetching feeds.
    ctx.waitUntil(
      persistArticleMeta(env, articles.map(wireArticleFromFeed)).catch(() => {}),
    );
    return response;
  }

  if (url.pathname === '/og-image' && request.method === 'GET') {
    const target = url.searchParams.get('url');
    if (!target || !isAllowedOgFetchUrl(target)) {
      return json({ imageUrl: null }, request, env, { status: 400 });
    }

    const cacheKey = new Request(url.toString(), { method: 'GET' });
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) {
      return replayCached(cached, request, env);
    }

    let html: string;
    try {
      const upstream = await fetchValidated(target, {
        'User-Agent': 'Mozilla/5.0 (compatible; BoomerangRSS/1.0; +https://github.com/victusfate/boomerang) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      });
      if (!upstream || !upstream.ok) {
        return json({ imageUrl: null }, request, env, { status: 404 });
      }
      const cl = parseInt(upstream.headers.get('Content-Length') ?? '0', 10);
      if (cl > MAX_HTML_BYTES) return json({ imageUrl: null }, request, env, { status: HTTP_PAYLOAD_TOO_LARGE });
      const buf = await upstream.arrayBuffer();
      if (buf.byteLength > MAX_HTML_BYTES) return json({ imageUrl: null }, request, env, { status: HTTP_PAYLOAD_TOO_LARGE });
      html = new TextDecoder().decode(buf);
    } catch {
      return json({ imageUrl: null }, request, env, { status: 404 });
    }

    const resolved = extractOgImageFromHtml(html, target);
    const body = { imageUrl: resolved ?? null };
    const response = json(body, request, env, undefined, IMAGE_PROXY_CACHE_TTL_SEC);
    ctx.waitUntil(
      cache.put(cacheKey, response.clone()).catch(() => { /* ignore transient cache failures */ }),
    );
    return response;
  }

  if (url.pathname === '/image' && request.method === 'GET') {
    const target = url.searchParams.get('url');
    if (!target || !isAllowedOgFetchUrl(target)) {
      return new Response('Bad Request', { status: 400, headers: corsHeaders(request, env) });
    }

    const cacheKey = new Request(url.toString(), { method: 'GET' });
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) {
      return replayCached(cached, request, env);
    }

    let upstream: Response | null;
    try {
      upstream = await fetchValidated(target, {
        'User-Agent': 'BoomerangRSS/1.0 (image-proxy; +https://github.com/victusfate/boomerang)',
      });
    } catch {
      return new Response(null, { status: 502, headers: corsHeaders(request, env) });
    }

    if (!upstream || !upstream.ok) {
      return new Response(null, { status: 502, headers: corsHeaders(request, env) });
    }

    const mime = upstream.headers.get('Content-Type') ?? '';
    if (mime.includes('text/html')) {
      return new Response(null, { status: 422, headers: corsHeaders(request, env) });
    }
    const imgCl = parseInt(upstream.headers.get('Content-Length') ?? '0', 10);
    if (imgCl > MAX_IMAGE_BYTES) {
      return new Response(null, { status: 413, headers: corsHeaders(request, env) });
    }
    const imgBuf = await upstream.arrayBuffer();
    if (imgBuf.byteLength > MAX_IMAGE_BYTES) {
      return new Response(null, { status: 413, headers: corsHeaders(request, env) });
    }

    const out = new Headers(corsHeaders(request, env));
    const ct = mime.startsWith('image/') ? mime : (mime || 'application/octet-stream');
    out.set('Content-Type', ct);
    out.set('Cache-Control', `public, max-age=${IMAGE_PROXY_CACHE_TTL_SEC}`);
    const res = new Response(imgBuf, { status: HTTP_OK, headers: out });
    ctx.waitUntil(
      cache.put(cacheKey, res.clone()).catch(() => { /* ignore transient cache failures */ }),
    );
    return res;
  }

  return new Response('Not Found', { status: 404, headers: corsHeaders(request, env) });
}
