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
const POOL_REC_DEBOUNCE_MS   = 400;

export type RecStatus = 'disabled' | 'active' | 'error';

export interface UseRecWorkerResult {
  sendInteraction: (input: RecInteractionInput) => void;
  recArticleIds:   string[];
  recScoreById:    Record<string, number>;
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

  const userIdRef = useRef<string | null>(null);
  const bufferRef = useRef<RecInteractionInput[]>([]);
  const poolFetchKeyRef = useRef<string>('');

  const poolKey = useMemo(
    () => (articlePoolIds.length > 0 ? articlePoolIds.slice().sort().join(',') : ''),
    [articlePoolIds],
  );

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

  const fetchPoolRecs = useCallback(async (ids: string[]) => {
    if (!WORKER_BASE) return;
    try {
      if (!userIdRef.current) {
        userIdRef.current = await getOrCreateRecUserId();
      }
      const recs = await fetchFeedPoolRecommendations(WORKER_BASE, userIdRef.current, ids);
      applyRecResponse(recs, recSetters);
      setRecStatus('active');
      setRecBootstrapError(null);
    } catch {
      setRecStatus('error');
      console.warn('[rec] Feed-pool recommendations fetch failed; keeping existing local order.');
    } finally {
      setRecBootstrapDone(true);
    }
  }, [recSetters]);

  // Feed-pool ranking when article ids are available (debounced; no global rec fetch)
  useEffect(() => {
    if (!WORKER_BASE) return;
    if (!poolKey) {
      void getOrCreateRecUserId()
        .then(id => { userIdRef.current = id; })
        .catch(() => {
          setRecStatus('error');
          setRecBootstrapError('failed to create recommendation user id');
        })
        .finally(() => { setRecBootstrapDone(true); });
      return;
    }

    if (poolFetchKeyRef.current === poolKey) return;
    const timer = window.setTimeout(() => {
      poolFetchKeyRef.current = poolKey;
      void fetchPoolRecs(articlePoolIds);
    }, POOL_REC_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [poolKey, articlePoolIds, fetchPoolRecs]);

  // Periodic pool-scoped refresh (aligned with KV TTL)
  useEffect(() => {
    if (!WORKER_BASE || !poolKey) return;
    const t = setInterval(() => {
      if (userIdRef.current && articlePoolIds.length > 0) {
        void fetchPoolRecs(articlePoolIds);
      }
    }, RECS_FETCH_INTERVAL_MS);
    return () => clearInterval(t);
  }, [poolKey, articlePoolIds, fetchPoolRecs]);

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
  };
}
