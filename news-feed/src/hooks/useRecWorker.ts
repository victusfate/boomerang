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

const FLUSH_INTERVAL_MS = 30_000;
const FLUSH_BATCH_SIZE  = 50;

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

  const userIdRef     = useRef<string | null>(null);
  const bufferRef     = useRef<RecInteractionInput[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const flush = useCallback(async () => {
    if (!WORKER_BASE || !userIdRef.current || bufferRef.current.length === 0) return;
    const batch = bufferRef.current.splice(0, FLUSH_BATCH_SIZE);
    try {
      await postInteractions(WORKER_BASE, userIdRef.current, batch);
      const recs = await fetchRecommendations(WORKER_BASE, userIdRef.current);
      setRecArticleIds(recs.articleIds);
      setRecStatus('active');
    } catch {
      bufferRef.current.unshift(...batch);
      setRecStatus('error');
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
        // silent — local ranking still works without recs
      }
    });
    return () => { cancelled = true; };
  }, []);

  // Periodic flush
  useEffect(() => {
    if (!WORKER_BASE) return;
    flushTimerRef.current = setInterval(() => { void flush(); }, FLUSH_INTERVAL_MS);
    return () => {
      if (flushTimerRef.current) clearInterval(flushTimerRef.current);
    };
  }, [flush]);

  const sendInteraction = useCallback((input: RecInteractionInput) => {
    if (!WORKER_BASE) return;
    bufferRef.current.push(input);
    if (bufferRef.current.length >= FLUSH_BATCH_SIZE) void flush();
  }, [flush]);

  return { sendInteraction, recArticleIds, recStatus, recEnvError };
}
