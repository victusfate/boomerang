import type { Env } from '../../env';
import { corsHeaders } from '../../cors';
import { DEFAULT_SOURCES, SOURCE_BY_ID, type NewsSource } from './sources';
import { fetchFeedsStaggered } from './rssFetch';
import { extractOgImageFromHtml, isAllowedOgFetchUrl } from './ogImage';

const BUNDLE_CACHE_TTL_SEC = 300;
const IMAGE_PROXY_CACHE_TTL_SEC = 86_400;
const ARTICLE_META_TTL_SEC = 86_400;   // 24 h — kept alive across bundle refreshes
const MAX_HTML_BYTES = 1 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

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
      const h = new Headers(cached.headers);
      const cors = corsHeaders(request, env);
      cors.forEach((v, k) => h.set(k, v));
      return new Response(cached.body, { status: cached.status, headers: h });
    }

    const sources = resolveSources(url.searchParams);
    const customSources = resolveCustomSources(url.searchParams);
    if (sources.length === 0 && customSources.length === 0) {
      return json(
        { ok: false, message: 'No valid sources in include=', articles: [], errors: [], fetchedAt: Date.now() },
        request, env, { status: 400 },
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
      Promise.all(articles.map(a =>
        env.REC_STORE.put(
          `rec:article-meta:${a.id}`,
          JSON.stringify({ id: a.id, title: a.title, source: a.source, sourceId: a.sourceId, publishedAt: a.publishedAt, url: a.url }),
          { expirationTtl: ARTICLE_META_TTL_SEC },
        ).catch(() => {}),
      )),
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
      const h = new Headers(cached.headers);
      const cors = corsHeaders(request, env);
      cors.forEach((v, k) => h.set(k, v));
      return new Response(cached.body, { status: cached.status, headers: h });
    }

    let html: string;
    try {
      const upstream = await fetch(target, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; BoomerangRSS/1.0; +https://github.com/victusfate/boomerang) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (!upstream.ok) {
        return json({ imageUrl: null }, request, env, { status: 404 });
      }
      const cl = parseInt(upstream.headers.get('Content-Length') ?? '0', 10);
      if (cl > MAX_HTML_BYTES) return json({ imageUrl: null }, request, env, { status: 413 });
      const buf = await upstream.arrayBuffer();
      if (buf.byteLength > MAX_HTML_BYTES) return json({ imageUrl: null }, request, env, { status: 413 });
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
      const h = new Headers(cached.headers);
      const cors = corsHeaders(request, env);
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
      return new Response(null, { status: 502, headers: corsHeaders(request, env) });
    }

    if (!upstream.ok) {
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
    const res = new Response(imgBuf, { status: 200, headers: out });
    ctx.waitUntil(
      cache.put(cacheKey, res.clone()).catch(() => { /* ignore transient cache failures */ }),
    );
    return res;
  }

  return new Response('Not Found', { status: 404, headers: corsHeaders(request, env) });
}
