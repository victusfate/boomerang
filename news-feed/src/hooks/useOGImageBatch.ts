import { useState, useEffect, useRef, useCallback } from 'react';
import type { Article } from '../types';
import { getRssWorkerBaseUrl } from '../services/newsService';

const OG_LS_KEY = 'og_cache_v1';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
  imageUrl: string | null;
  cachedAt: number;
}

function normalizeUrl(raw: string): string {
  const s = raw.trim().replace(/&amp;/g, '&');
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : s;
  } catch { return s; }
}

function resolveUrl(raw: string, base: string): string | null {
  const t = raw.trim();
  if (!t || t.startsWith('?') || t.startsWith('&')) return null;
  try {
    const u = new URL(t, base);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
  } catch { return null; }
}

function readCache(): Map<string, CacheEntry> {
  try {
    const raw = localStorage.getItem(OG_LS_KEY);
    if (!raw) return new Map();
    const obj = JSON.parse(raw) as Record<string, CacheEntry>;
    const now = Date.now();
    const m = new Map<string, CacheEntry>();
    for (const [k, v] of Object.entries(obj)) {
      if (now - v.cachedAt < CACHE_TTL_MS) m.set(k, v);
    }
    return m;
  } catch { return new Map(); }
}

function persistCache(cache: Map<string, CacheEntry>): void {
  try {
    const obj: Record<string, CacheEntry> = {};
    for (const [k, v] of cache) obj[k] = v;
    localStorage.setItem(OG_LS_KEY, JSON.stringify(obj));
  } catch {}
}

export function useOGImageBatch(
  articles: Article[],
  batchSize = 10,
): { ogMap: Map<string, string | null>; sentinelRef: React.RefObject<HTMLDivElement | null>; fetchedUpTo: number } {
  const lsCache = useRef<Map<string, CacheEntry>>(readCache());
  const initiated = useRef<Set<string>>(new Set());

  const [ogMap, setOgMap] = useState<Map<string, string | null>>(new Map());
  const [fetchedUpTo, setFetchedUpTo] = useState(batchSize);
  const fetchedUpToRef = useRef(batchSize);
  const articlesRef = useRef(articles);
  articlesRef.current = articles;
  const sentinelRef = useRef<HTMLDivElement>(null);

  const fetchSlice = useCallback(async (slice: Article[]) => {
    const cacheHits: Array<[string, string | null]> = [];
    const toFetch: Article[] = [];

    for (const a of slice) {
      if (a.imageUrl) continue; // has RSS image — skip og fetch
      if (initiated.current.has(a.id)) continue;
      initiated.current.add(a.id);

      const url = normalizeUrl(a.url);
      const cached = lsCache.current.get(url);
      if (cached) {
        cacheHits.push([a.id, cached.imageUrl]);
      } else {
        toFetch.push(a);
      }
    }

    if (cacheHits.length > 0) {
      setOgMap(prev => {
        const next = new Map(prev);
        for (const [id, img] of cacheHits) next.set(id, img);
        return next;
      });
    }

    if (toFetch.length === 0) return;

    let workerBase: string;
    try { workerBase = getRssWorkerBaseUrl(); } catch { return; }

    const results = await Promise.allSettled(
      toFetch.map(async (a): Promise<[string, string | null]> => {
        const pageUrl = normalizeUrl(a.url);
        try {
          const res = await fetch(
            `${workerBase}/og-image?url=${encodeURIComponent(pageUrl)}`,
            { signal: AbortSignal.timeout(10_000) },
          );
          if (!res.ok) {
            lsCache.current.set(pageUrl, { imageUrl: null, cachedAt: Date.now() });
            return [a.id, null];
          }
          const d = (await res.json()) as { imageUrl: string | null };
          const resolved = d.imageUrl ? (resolveUrl(d.imageUrl, pageUrl) ?? d.imageUrl) : null;
          lsCache.current.set(pageUrl, { imageUrl: resolved, cachedAt: Date.now() });
          return [a.id, resolved];
        } catch {
          return [a.id, null];
        }
      }),
    );

    persistCache(lsCache.current);

    const updates = results
      .filter((r): r is PromiseFulfilledResult<[string, string | null]> => r.status === 'fulfilled')
      .map(r => r.value);

    if (updates.length > 0) {
      setOgMap(prev => {
        const next = new Map(prev);
        for (const [id, img] of updates) next.set(id, img);
        return next;
      });
    }
  }, []);

  // Fetch when fetchedUpTo changes (sentinel triggered next batch)
  useEffect(() => {
    const end = Math.min(fetchedUpToRef.current, articlesRef.current.length);
    void fetchSlice(articlesRef.current.slice(0, end));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchedUpTo, fetchSlice]);

  // Fetch when new articles load (progressive load grows the list)
  useEffect(() => {
    const end = Math.min(fetchedUpToRef.current, articles.length);
    void fetchSlice(articles.slice(0, end));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [articles.length, fetchSlice]);

  // Sentinel: when scrolled into view, unlock the next batch
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      entries => {
        if (!entries[0].isIntersecting) return;
        setFetchedUpTo(prev => {
          const next = prev + batchSize;
          fetchedUpToRef.current = next;
          return next;
        });
      },
      { rootMargin: '400px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [batchSize, fetchedUpTo]); // re-observe when sentinel moves to new position

  return { ogMap, sentinelRef, fetchedUpTo };
}
