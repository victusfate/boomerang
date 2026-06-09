import { useEffect, useRef } from 'react';
import type { Article, UserPrefs } from '../types';
import { postInteractions, fetchRecArticles } from '../services/recWorker';
import { DEFAULT_SOURCES } from '../services/newsService';
import { PLATFORM_WORKER_URL } from '../config/workerEnv';

const MAX_REPLAY_IDS = 180;
const REPLAY_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 h

// localStorage keys — client-side only, no Cloudflare KV reads
const LS_REPLAY_AT  = 'rec:last-replay-at';
const LS_SRC_CACHE  = 'rec:article-source-cache:v1';
const MAX_SRC_CACHE = 500;

type SourceEntry = { sourceId: string; topics: string[] };

const SOURCE_TOPIC_MAP = new Map<string, string[]>(
  DEFAULT_SOURCES.map(s => [s.id, [s.category]]),
);

function inferTopics(sourceId: string): string[] {
  if (sourceId.startsWith('custom-')) return ['general'];
  return SOURCE_TOPIC_MAP.get(sourceId) ?? ['general'];
}

// ── localStorage helpers (synchronous, no Cloudflare KV) ─────────────────────

function lsGetNumber(key: string): number | null {
  try { const v = localStorage.getItem(key); return v ? parseInt(v, 10) : null; } catch { return null; }
}

function lsSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* storage full */ }
}

function loadSourceCache(): Map<string, SourceEntry> {
  try {
    const raw = localStorage.getItem(LS_SRC_CACHE);
    if (!raw) return new Map();
    return new Map(Object.entries(JSON.parse(raw) as Record<string, SourceEntry>));
  } catch { return new Map(); }
}

function saveSourceCache(cache: Map<string, SourceEntry>): void {
  try {
    let entries = [...cache.entries()];
    if (entries.length > MAX_SRC_CACHE) entries = entries.slice(entries.length - MAX_SRC_CACHE);
    lsSet(LS_SRC_CACHE, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* ignore */ }
}

/**
 * Once per 6 h (localStorage cooldown), replay strong-signal interactions
 * (save, upvote, downvote, read) from local prefs so the CF model sees
 * historical preference data — not just live-session events.
 *
 * Article sourceId/topics for articles that have aged out of the feed are
 * resolved from a localStorage cache first, then /rec/articles for any
 * remaining misses. This keeps Cloudflare KV reads near-zero after the
 * first replay.
 */
export function useRecHistoryReplay(
  prefs: UserPrefs,
  allArticles: Article[],
  savedArticles: Article[],
  recUserId: string | null,
  recBootstrapDone: boolean,
): void {
  const replayedRef = useRef(false);
  const allArticlesRef    = useRef<Article[]>(allArticles);
  const savedArticlesRef  = useRef<Article[]>(savedArticles);
  const prefsRef          = useRef<UserPrefs>(prefs);
  allArticlesRef.current   = allArticles;
  savedArticlesRef.current = savedArticles;
  prefsRef.current         = prefs;

  const articlesReady = allArticles.length > 0 || savedArticles.length > 0;

  useEffect(() => {
    if (!PLATFORM_WORKER_URL || !recBootstrapDone || !recUserId || !articlesReady) return;
    if (replayedRef.current) return;
    replayedRef.current = true;

    // Cooldown check — synchronous localStorage read, no network
    const lastReplay = lsGetNumber(LS_REPLAY_AT);
    if (lastReplay !== null && Date.now() - lastReplay < REPLAY_COOLDOWN_MS) {
      console.info('[rec] history replay: skipped (within 6 h cooldown)');
      return;
    }

    void (async () => {
      const p = prefsRef.current;
      const articleById = new Map<string, Article>();
      for (const a of allArticlesRef.current)   articleById.set(a.id, a);
      for (const a of savedArticlesRef.current)  articleById.set(a.id, a);

      const now = Date.now();
      type PendingEvent = { articleId: string; action: 'save' | 'upvote' | 'downvote' | 'read'; ts: number };
      const pending: PendingEvent[] = [];
      const seen = new Set<string>();

      for (const id of p.savedIds) {
        if (seen.has(id)) continue; seen.add(id);
        pending.push({ articleId: id, action: 'save', ts: p.savedAtById?.[id] ?? now });
      }
      for (const id of p.upvotedIds ?? []) {
        if (seen.has(id)) continue; seen.add(id);
        pending.push({ articleId: id, action: 'upvote', ts: now });
      }
      for (const id of p.downvotedIds ?? []) {
        if (seen.has(id)) continue; seen.add(id);
        pending.push({ articleId: id, action: 'downvote', ts: now });
      }
      for (const id of p.readIds ?? []) {
        if (seen.has(id)) continue; seen.add(id);
        pending.push({ articleId: id, action: 'read', ts: now });
      }

      const capped = pending.slice(0, MAX_REPLAY_IDS);
      const sourceCache = loadSourceCache(); // synchronous localStorage read
      type ResolvedEvent = { articleId: string; sourceId: string; topics: string[]; action: string; ts: number };
      const resolved: ResolvedEvent[] = [];
      const needsKvFetch: string[] = [];

      for (const { articleId, action, ts } of capped) {
        const a = articleById.get(articleId);
        if (a?.sourceId && a.topics.length) {
          // In current feed pool — use directly and update the local cache
          resolved.push({ articleId, sourceId: a.sourceId, topics: a.topics, action, ts });
          sourceCache.set(articleId, { sourceId: a.sourceId, topics: a.topics });
        } else {
          const cached = sourceCache.get(articleId);
          if (cached) {
            // Already resolved from a previous replay — no KV read needed
            resolved.push({ articleId, sourceId: cached.sourceId, topics: cached.topics, action, ts });
          } else {
            needsKvFetch.push(articleId);
          }
        }
      }

      // Only fetch from /rec/articles for IDs not in localStorage cache
      const needsKvFetchSet = new Set(needsKvFetch);
      if (needsKvFetch.length > 0) {
        try {
          const meta = await fetchRecArticles(PLATFORM_WORKER_URL, needsKvFetch);
          const metaById = new Map(meta.articles.map(m => [m.id, m]));
          for (const { articleId, action, ts } of capped) {
            if (!needsKvFetchSet.has(articleId)) continue;
            const m = metaById.get(articleId);
            if (!m?.sourceId) continue;
            const topics = inferTopics(m.sourceId);
            resolved.push({ articleId, sourceId: m.sourceId, topics, action, ts });
            sourceCache.set(articleId, { sourceId: m.sourceId, topics });
          }
        } catch {
          // /rec/articles unavailable — proceed with what we have
        }
      }

      saveSourceCache(sourceCache); // write updated cache back to localStorage

      if (resolved.length === 0) {
        console.info('[rec] history replay: no resolvable interactions');
        return;
      }

      const summary = resolved.reduce<Record<string, number>>((acc, e) => {
        acc[e.action] = (acc[e.action] ?? 0) + 1;
        return acc;
      }, {});
      console.info('[rec] history replay: posting to platform worker', {
        total: resolved.length,
        skipped: pending.length - resolved.length,
        fromCache: resolved.filter(r => !needsKvFetchSet.has(r.articleId)).length,
        kvFetched: needsKvFetch.length,
        ...summary,
      });

      await postInteractions(PLATFORM_WORKER_URL, recUserId, resolved as Parameters<typeof postInteractions>[2]);
      lsSet(LS_REPLAY_AT, String(Date.now()));
      console.info('[rec] history replay: done');
    })().catch((e) => { console.warn('[rec] history replay failed', e); });
  }, [recBootstrapDone, recUserId, articlesReady]);
}
