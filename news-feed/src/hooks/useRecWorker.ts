import { useState, useEffect, useRef, useCallback } from 'react';
import { resolveWorkerUrl, missingWorkerEnvMessage } from '../config/workerEnv';
import {
  getOrCreateRecUserId,
  postInteractions,
  fetchRecommendations,
  type RecInteractionInput,
} from '../services/recWorker';
import { recordInteraction } from '../services/recStats';

export type { RecInteractionInput };

const WORKER_BASE = resolveWorkerUrl(import.meta.env.VITE_REC_WORKER_URL);

const FLUSH_INTERVAL_MS      = 30_000;       // POST interactions every 30 s
const RECS_FETCH_INTERVAL_MS = 5 * 60_000;   // fetch recs every 5 min (matches KV TTL)
const FLUSH_BATCH_SIZE       = 50;

export type RecStatus = 'disabled' | 'active' | 'error';

export interface UseRecWorkerResult {
  sendInteraction: (input: RecInteractionInput) => void;
  recArticleIds:   string[];
  recStatus:       RecStatus;
  recEnvError:     string | null;
  recBootstrapDone: boolean;
  recBootstrapError: string | null;
}

export function useRecWorker(): UseRecWorkerResult {
  const [recEnvError] = useState<string | null>(() =>
    WORKER_BASE ? null : missingWorkerEnvMessage('VITE_REC_WORKER_URL'),
  );
  const [recArticleIds, setRecArticleIds] = useState<string[]>([]);
  const [recStatus, setRecStatus] = useState<RecStatus>(() =>
    WORKER_BASE ? 'active' : 'disabled',
  );
  const [recBootstrapDone, setRecBootstrapDone] = useState<boolean>(() => !WORKER_BASE);
  const [recBootstrapError, setRecBootstrapError] = useState<string | null>(null);

  const userIdRef = useRef<string | null>(null);
  const bufferRef = useRef<RecInteractionInput[]>([]);

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

  // Fetch fresh recommendations (separate from flush — KV TTL is 5 min)
  const fetchRecs = useCallback(async () => {
    if (!WORKER_BASE || !userIdRef.current) return;
    try {
      const recs = await fetchRecommendations(WORKER_BASE, userIdRef.current);
      setRecArticleIds(recs.articleIds);
      setRecStatus('active');
      setRecBootstrapError(null);
    } catch {
      setRecStatus('error');
      console.warn('[rec] Recommendations fetch failed; keeping existing local order.');
    }
  }, []);

  // Resolve userId + fetch initial recs on mount
  useEffect(() => {
    if (!WORKER_BASE) return;
    let cancelled = false;
    getOrCreateRecUserId()
      .then(async id => {
        if (cancelled) return;
        userIdRef.current = id;
        try {
          const recs = await fetchRecommendations(WORKER_BASE, id);
          if (!cancelled) {
            setRecArticleIds(recs.articleIds);
            setRecStatus('active');
            setRecBootstrapDone(true);
            setRecBootstrapError(null);
          }
        } catch {
          if (!cancelled) {
            setRecStatus('error');
            setRecBootstrapDone(true);
            setRecBootstrapError('initial recommendations fetch failed');
            console.warn('[rec] Initial recommendation fetch failed; local ranking fallback will be used.');
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRecStatus('error');
          setRecBootstrapDone(true);
          setRecBootstrapError('failed to create recommendation user id');
          console.warn('[rec] Recommendation bootstrap failed; local ranking fallback will be used.');
        }
      });
    return () => { cancelled = true; };
  }, []);

  // Periodic flush timer
  useEffect(() => {
    if (!WORKER_BASE) return;
    const t = setInterval(() => { void flush(); }, FLUSH_INTERVAL_MS);
    return () => clearInterval(t);
  }, [flush]);

  // Periodic rec fetch timer (aligned with KV TTL)
  useEffect(() => {
    if (!WORKER_BASE) return;
    const t = setInterval(() => { void fetchRecs(); }, RECS_FETCH_INTERVAL_MS);
    return () => clearInterval(t);
  }, [fetchRecs]);

  const sendInteraction = useCallback((input: RecInteractionInput) => {
    if (!WORKER_BASE) return;
    bufferRef.current.push(input);
    void recordInteraction(input); // fire-and-forget — updates local stats for diagnostics
    if (bufferRef.current.length >= FLUSH_BATCH_SIZE) void flush();
  }, [flush]);

  return { sendInteraction, recArticleIds, recStatus, recEnvError, recBootstrapDone, recBootstrapError };
}
