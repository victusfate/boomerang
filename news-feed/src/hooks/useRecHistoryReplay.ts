import { useEffect, useRef } from 'react';
import type { Article, UserPrefs } from '../types';
import { postInteractions, fetchRecArticles } from '../services/recWorker';
import { DEFAULT_SOURCES } from '../services/newsService';
import { resolveWorkerUrl } from '../config/workerEnv';

const WORKER_BASE = resolveWorkerUrl(import.meta.env.VITE_REC_WORKER_URL);

/** Cap total ids to avoid flooding the rate limiter (200 events / batch max). */
const MAX_REPLAY_IDS = 180;

/** sourceId → [topic] from built-in source list; custom- sources fall back to ['general']. */
const SOURCE_TOPIC_MAP = new Map<string, string[]>(
  DEFAULT_SOURCES.map(s => [s.id, [s.category]]),
);

function inferTopics(sourceId: string): string[] {
  if (sourceId.startsWith('custom-')) return ['general'];
  return SOURCE_TOPIC_MAP.get(sourceId) ?? ['general'];
}

/**
 * Once per page load (guarded by replayedRef), replay strong-signal interactions
 * (save, upvote, downvote, read) from local prefs so the CF model sees historical
 * preference data — not just live-session events.
 *
 * Safe to run on every load: RecDO deduplicates on (userId, articleId, action).
 * Duplicate events only update the stored timestamp; no MF gradient step is taken.
 *
 * For saved articles not in the current feed pool, metadata (sourceId → topics) is
 * resolved via GET /rec/articles so historical saves are included in the replay.
 */
export function useRecHistoryReplay(
  prefs: UserPrefs,
  allArticles: Article[],
  savedArticles: Article[],
  recUserId: string | null,
  recBootstrapDone: boolean,
): void {
  const replayedRef = useRef(false);
  // Use refs so the effect dep array stays minimal but we always read fresh data.
  const allArticlesRef = useRef<Article[]>(allArticles);
  const savedArticlesRef = useRef<Article[]>(savedArticles);
  const prefsRef = useRef<UserPrefs>(prefs);
  allArticlesRef.current = allArticles;
  savedArticlesRef.current = savedArticles;
  prefsRef.current = prefs;

  const articlesReady = allArticles.length > 0 || savedArticles.length > 0;

  useEffect(() => {
    if (!WORKER_BASE || !recBootstrapDone || !recUserId || !articlesReady) return;
    if (replayedRef.current) return;
    replayedRef.current = true;

    void (async () => {
      const p = prefsRef.current;
      const articleById = new Map<string, Article>();
      for (const a of allArticlesRef.current) articleById.set(a.id, a);
      for (const a of savedArticlesRef.current) articleById.set(a.id, a);

      const now = Date.now();
      type PendingEvent = { articleId: string; action: 'save' | 'upvote' | 'downvote' | 'read'; ts: number };
      const pending: PendingEvent[] = [];
      const seen = new Set<string>();

      // Priority order: save > upvote > downvote > read
      for (const id of p.savedIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        pending.push({ articleId: id, action: 'save', ts: p.savedAtById?.[id] ?? now });
      }
      for (const id of p.upvotedIds ?? []) {
        if (seen.has(id)) continue;
        seen.add(id);
        pending.push({ articleId: id, action: 'upvote', ts: now });
      }
      for (const id of p.downvotedIds ?? []) {
        if (seen.has(id)) continue;
        seen.add(id);
        pending.push({ articleId: id, action: 'downvote', ts: now });
      }
      // Read IDs = click-through opens; good signal but lower priority than explicit votes/saves.
      for (const id of p.readIds ?? []) {
        if (seen.has(id)) continue;
        seen.add(id);
        pending.push({ articleId: id, action: 'read', ts: now });
      }

      const capped = pending.slice(0, MAX_REPLAY_IDS);

      // Split: articles resolvable from local pool vs those that have aged out of the feed.
      type ResolvedEvent = { articleId: string; sourceId: string; topics: string[]; action: string; ts: number };
      const resolved: ResolvedEvent[] = [];
      const unresolvedIds: string[] = [];

      for (const { articleId, action, ts } of capped) {
        const a = articleById.get(articleId);
        if (a?.sourceId && a.topics.length) {
          resolved.push({ articleId, sourceId: a.sourceId, topics: a.topics, action, ts });
        } else {
          unresolvedIds.push(articleId);
        }
      }

      // For articles not in the current pool, fetch metadata from /rec/articles.
      // sourceId from KV + category from DEFAULT_SOURCES → topics.
      if (unresolvedIds.length > 0 && WORKER_BASE) {
        try {
          const meta = await fetchRecArticles(WORKER_BASE, unresolvedIds);
          const metaById = new Map(meta.articles.map(m => [m.id, m]));
          for (const { articleId, action, ts } of capped) {
            if (articleById.has(articleId)) continue; // already resolved above
            const m = metaById.get(articleId);
            if (!m?.sourceId) continue;
            resolved.push({
              articleId,
              sourceId: m.sourceId,
              topics: inferTopics(m.sourceId),
              action,
              ts,
            });
          }
        } catch {
          // /rec/articles unavailable — proceed with what we have
        }
      }

      if (resolved.length === 0) {
        console.info('[rec] history replay: no resolvable interactions (articles not in pool or KV)');
        return;
      }

      const summary = resolved.reduce<Record<string, number>>((acc, e) => {
        acc[e.action] = (acc[e.action] ?? 0) + 1;
        return acc;
      }, {});
      console.info('[rec] history replay: posting to platform worker', {
        total: resolved.length,
        skipped: pending.length - resolved.length,
        ...summary,
      });

      await postInteractions(WORKER_BASE, recUserId, resolved as Parameters<typeof postInteractions>[2]);
      console.info('[rec] history replay: done');
    })().catch((e) => { console.warn('[rec] history replay failed', e); });
  }, [recBootstrapDone, recUserId, articlesReady]);
}
