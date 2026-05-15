import { useEffect, useRef } from 'react';
import type { Article, UserPrefs } from '../types';
import { postInteractions } from '../services/recWorker';
import { resolveWorkerUrl } from '../config/workerEnv';
import { kvGet, kvSet } from '../services/kvStore';

const WORKER_BASE = resolveWorkerUrl(import.meta.env.VITE_REC_WORKER_URL);

/** Re-replay saved/voted/read history after 6 h to catch sync merges and new sessions. */
const REPLAY_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const REPLAY_KEY = 'rec:last-replay-at';
/** Cap total ids to avoid flooding the rate limiter (200 events / batch max). */
const MAX_REPLAY_IDS = 180;

/**
 * On each session, once the rec worker is ready and articles are loaded, replay
 * strong-signal interactions (save, upvote, downvote, read) from local prefs so
 * the CF model sees historical preference data — not just live-session events.
 *
 * Throttled to once per REPLAY_COOLDOWN_MS to catch cross-browser syncs without
 * flooding the worker. RecDO deduplicates on (userId, articleId, action) so
 * replaying the same event is safe.
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
      const lastReplay = await kvGet<number>(REPLAY_KEY);
      if (lastReplay !== undefined && Date.now() - lastReplay < REPLAY_COOLDOWN_MS) return;

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

      // isValidEvent requires sourceId and at least one topic; skip articles not in current pool.
      const resolved = pending
        .slice(0, MAX_REPLAY_IDS)
        .flatMap(({ articleId, action, ts }) => {
          const a = articleById.get(articleId);
          if (!a?.sourceId || !a.topics.length) return [];
          return [{ articleId, sourceId: a.sourceId, topics: a.topics, action, ts }];
        });

      if (resolved.length === 0) return;

      await postInteractions(WORKER_BASE, recUserId, resolved);
      await kvSet(REPLAY_KEY, Date.now());
    })().catch(() => {});
  }, [recBootstrapDone, recUserId, articlesReady]);
}
