import { useState, useEffect, useRef, useCallback } from 'react';
import { workerUrlFromEnv, missingWorkerEnvMessage } from '../config/workerEnv';
import {
  getOrCreateRecUserId,
  postInteractions,
  fetchRecommendations,
  type RecInteractionInput,
} from '../services/recWorker';

export type { RecInteractionInput };

const WORKER_BASE = workerUrlFromEnv(import.meta.env.VITE_REC_WORKER_URL);

const FLUSH_INTERVAL_MS      = 30_000;       // POST interactions every 30 s
const RECS_FETCH_INTERVAL_MS = 5 * 60_000;   // fetch recs every 5 min (matches KV TTL)
const FLUSH_BATCH_SIZE       = 50;

export type RecStatus = 'disabled' | 'active' | 'error';

export interface UseRecWorkerResult {
  sendInteraction: (input: RecInteractionInput) => void;
  recArticleIds:   string[];
  recStatus:       RecStatus;
  recEnvError:     string | null;
}

export function useRecWorker(): UseRecWorkerResult {
  const [recEnvError] = useState<string | null>(() =>
    WORKER_BASE ? null : missingWorkerEnvMessage('VITE_REC_WORKER_URL'),
  );
  const [recArticleIds, setRecArticleIds] = useState<string[]>([]);
  const [recStatus, setRecStatus] = useState<RecStatus>(() =>
    WORKER_BASE ? 'active' : 'disabled',
  );

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
    } catch {
      // silent — local ranking still works without recs
    }
  }, []);

  // Resolve userId + fetch initial recs on mount
  useEffect(() => {
    if (!WORKER_BASE) return;
    let cancelled = false;
    getOrCreateRecUserId().then(async id => {
      if (cancelled) return;
      userIdRef.current = id;
      try {
        const recs = await fetchRecommendations(WORKER_BASE, id);
        if (!cancelled) setRecArticleIds(recs.articleIds);
      } catch {
        // silent cold start
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
    if (bufferRef.current.length >= FLUSH_BATCH_SIZE) void flush();
  }, [flush]);

  return { sendInteraction, recArticleIds, recStatus, recEnvError };
}
