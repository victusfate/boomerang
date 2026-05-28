import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { resolveWorkerUrl, missingWorkerEnvMessage } from '../config/workerEnv';
import {
  getOrCreateRecUserId,
  postInteractions,
  fetchFeedPoolRecommendations,
  type RecInteractionInput,
  type RecResponseWithScores,
} from '../services/recWorker';
import { recordInteraction } from '../services/recStats';

export type { RecInteractionInput };

const WORKER_BASE = resolveWorkerUrl(import.meta.env.VITE_REC_WORKER_URL);

const FLUSH_INTERVAL_MS      = 30_000;       // POST interactions every 30 s
const RECS_FETCH_INTERVAL_MS = 5 * 60_000;   // fetch recs every 5 min (matches KV TTL)
const FLUSH_BATCH_SIZE       = 50;
const POOL_REC_DEBOUNCE_MS   = 1_500;

export type RecStatus = 'disabled' | 'active' | 'error';

export interface UseRecWorkerResult {
  sendInteraction:  (input: RecInteractionInput) => void;
  setTopicWeights:  (weights: Partial<Record<string, number>>) => void;
  recArticleIds:    string[];
  recScoreById:     Record<string, number>;
  recScoredArticles: RecResponseWithScores['scoredArticleIds'];
  recModelDiagnostics: RecResponseWithScores['diagnostics'] | null;
  recTrace: RecResponseWithScores['trace'] | null;
  recCacheInfo: RecResponseWithScores['cache'] | null;
  recTimingMs: RecResponseWithScores['timingMs'] | null;
  recGeneratedAt:  number | null;
  recStatus:       RecStatus;
  recEnvError:     string | null;
  recBootstrapDone: boolean;
  recBootstrapError: string | null;
  recUserId: string | null;
}

function applyRecResponse(
  recs: RecResponseWithScores,
  setters: {
    setRecArticleIds: (ids: string[]) => void;
    setRecScoreById: (v: Record<string, number>) => void;
    setRecScoredArticles: (v: RecResponseWithScores['scoredArticleIds']) => void;
    setRecModelDiagnostics: (v: RecResponseWithScores['diagnostics'] | null) => void;
    setRecTrace: (v: RecResponseWithScores['trace'] | null) => void;
    setRecCacheInfo: (v: RecResponseWithScores['cache'] | null) => void;
    setRecTimingMs: (v: RecResponseWithScores['timingMs'] | null) => void;
    setRecGeneratedAt: (v: number | null) => void;
  },
): void {
  setters.setRecArticleIds(recs.articleIds);
  setters.setRecScoreById(recs.scoreById);
  setters.setRecScoredArticles(recs.scoredArticleIds);
  setters.setRecModelDiagnostics(recs.diagnostics);
  setters.setRecTrace(recs.trace);
  setters.setRecCacheInfo(recs.cache);
  setters.setRecTimingMs(recs.timingMs);
  setters.setRecGeneratedAt(Number.isFinite(recs.generatedAt) ? recs.generatedAt : null);
}

/** Stable key for “same candidate set” without storing megabyte-long strings. */
function poolRecKey(ids: string[]): string {
  if (ids.length === 0) return '';
  const first = ids[0];
  const last = ids[ids.length - 1];
  return `${ids.length}:${first}:${last}`;
}

export function useRecWorker(articlePoolIds: string[] = []): UseRecWorkerResult {
  const [recEnvError] = useState<string | null>(() =>
    WORKER_BASE ? null : missingWorkerEnvMessage('VITE_REC_WORKER_URL'),
  );
  const [recArticleIds, setRecArticleIds] = useState<string[]>([]);
  const [recScoreById, setRecScoreById] = useState<Record<string, number>>({});
  const [recScoredArticles, setRecScoredArticles] = useState<RecResponseWithScores['scoredArticleIds']>([]);
  const [recModelDiagnostics, setRecModelDiagnostics] = useState<RecResponseWithScores['diagnostics'] | null>(null);
  const [recTrace, setRecTrace] = useState<RecResponseWithScores['trace'] | null>(null);
  const [recCacheInfo, setRecCacheInfo] = useState<RecResponseWithScores['cache'] | null>(null);
  const [recTimingMs, setRecTimingMs] = useState<RecResponseWithScores['timingMs'] | null>(null);
  const [recGeneratedAt, setRecGeneratedAt] = useState<number | null>(null);
  const [recStatus, setRecStatus] = useState<RecStatus>(() =>
    WORKER_BASE ? 'active' : 'disabled',
  );
  const [recBootstrapDone, setRecBootstrapDone] = useState<boolean>(() => !WORKER_BASE);
  const [recBootstrapError, setRecBootstrapError] = useState<string | null>(null);
  const [recUserId, setRecUserId] = useState<string | null>(null);

  const userIdRef = useRef<string | null>(null);
  const bufferRef = useRef<RecInteractionInput[]>([]);
  const poolFetchKeyRef = useRef<string>('');
  const poolFetchInFlightRef = useRef(false);
  const articlePoolIdsRef = useRef<string[]>(articlePoolIds);
  articlePoolIdsRef.current = articlePoolIds;
  const topicWeightsRef = useRef<Partial<Record<string, number>>>({});

  const poolKey = useMemo(() => poolRecKey(articlePoolIds), [articlePoolIds]);

  const recSetters = useMemo(() => ({
    setRecArticleIds,
    setRecScoreById,
    setRecScoredArticles,
    setRecModelDiagnostics,
    setRecTrace,
    setRecCacheInfo,
    setRecTimingMs,
    setRecGeneratedAt,
  }), []);

  const ensureRecUserId = useCallback(async (): Promise<string | null> => {
    if (!WORKER_BASE) return null;
    if (userIdRef.current) return userIdRef.current;
    const id = await getOrCreateRecUserId();
    userIdRef.current = id;
    setRecUserId(id);
    return id;
  }, []);

  // POST buffered interactions — no rec fetch here (KV cache would be stale)
  const flush = useCallback(async () => {
    if (!WORKER_BASE || !userIdRef.current || bufferRef.current.length === 0) return;
    const batch = bufferRef.current.splice(0, FLUSH_BATCH_SIZE);
    try {
      await postInteractions(WORKER_BASE, userIdRef.current, batch);
      setRecStatus('active');
    } catch {
      bufferRef.current.unshift(...batch);
      setRecStatus('error');
    }
  }, []);

  const setTopicWeights = useCallback((weights: Partial<Record<string, number>>) => {
    topicWeightsRef.current = weights;
  }, []);

  const fetchPoolRecs = useCallback(async (ids: string[]): Promise<boolean> => {
    if (!WORKER_BASE || poolFetchInFlightRef.current) return false;
    poolFetchInFlightRef.current = true;
    try {
      const userId = await ensureRecUserId();
      if (!userId) return false;
      const recs = await fetchFeedPoolRecommendations(WORKER_BASE, userId, ids, topicWeightsRef.current);
      applyRecResponse(recs, recSetters);
      setRecStatus('active');
      setRecBootstrapError(null);
      return true;
    } catch (e) {
      setRecStatus('error');
      const status = e instanceof Error && /rec-worker (\d+)/.exec(e.message)?.[1];
      if (status === '429') {
        console.warn('[rec] Rate limited on feed-pool ranking; will retry on next scheduled refresh.');
      } else {
        console.warn('[rec] Feed-pool recommendations fetch failed; keeping existing local order.');
      }
      return false;
    } finally {
      poolFetchInFlightRef.current = false;
      setRecBootstrapDone(true);
    }
  }, [recSetters, ensureRecUserId]);

  // Feed-pool ranking when candidate ids change (debounced; stable pool snapshots only)
  useEffect(() => {
    if (!WORKER_BASE) return;
    if (!poolKey) {
      void ensureRecUserId()
        .catch(() => {
          setRecStatus('error');
          setRecBootstrapError('failed to create recommendation user id');
        })
        .finally(() => { setRecBootstrapDone(true); });
      return;
    }

    if (poolFetchKeyRef.current === poolKey) return;
    const timer = window.setTimeout(() => {
      if (poolFetchKeyRef.current === poolKey) return;
      void fetchPoolRecs(articlePoolIds).then(ok => {
        if (ok) poolFetchKeyRef.current = poolKey;
      });
    }, POOL_REC_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [poolKey, articlePoolIds, fetchPoolRecs, ensureRecUserId]);

  // Periodic pool-scoped refresh (aligned with KV TTL) — interval does not reset on pool growth
  useEffect(() => {
    if (!WORKER_BASE) return;
    const t = setInterval(() => {
      const ids = articlePoolIdsRef.current;
      if (!userIdRef.current || ids.length === 0) return;
      const key = poolRecKey(ids);
      void fetchPoolRecs(ids).then(ok => {
        if (ok) poolFetchKeyRef.current = key;
      });
    }, RECS_FETCH_INTERVAL_MS);
    return () => clearInterval(t);
  }, [fetchPoolRecs]);

  // Periodic flush timer
  useEffect(() => {
    if (!WORKER_BASE) return;
    const t = setInterval(() => { void flush(); }, FLUSH_INTERVAL_MS);
    return () => clearInterval(t);
  }, [flush]);

  const sendInteraction = useCallback((input: RecInteractionInput) => {
    if (!WORKER_BASE) return;
    bufferRef.current.push(input);
    void recordInteraction(input);
    if (bufferRef.current.length >= FLUSH_BATCH_SIZE) void flush();
  }, [flush]);

  return {
    sendInteraction,
    setTopicWeights,
    recArticleIds,
    recScoreById,
    recScoredArticles,
    recModelDiagnostics,
    recTrace,
    recCacheInfo,
    recTimingMs,
    recGeneratedAt,
    recStatus,
    recEnvError,
    recBootstrapDone,
    recBootstrapError,
    recUserId,
  };
}
