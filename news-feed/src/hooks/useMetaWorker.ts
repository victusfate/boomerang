import { useState, useEffect, useRef, useCallback } from 'react';
import { workerUrlFromEnv, missingWorkerEnvMessage } from '../config/workerEnv';
import { fetchMetaTags, submitMetaTags, MetaRateLimitError } from '../services/metaWorker.ts';

const WORKER_BASE = workerUrlFromEnv(import.meta.env.VITE_META_WORKER_URL);
const MANUAL_META_SYNC_COOLDOWN_MS = 15_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 10 * 60_000;
const RATE_LIMIT_BACKOFF_BASE_MS = 2_000;
const RATE_LIMIT_BACKOFF_MAX_MS = 5 * 60_000;
const MAX_CONSECUTIVE_ERRORS = 5;

export type MetaTagsMap = Map<string, string[]>;
export type MetaStatus = 'disabled' | 'active' | 'syncing' | 'error';

export interface UseMetaWorkerResult {
  metaTagsMap: MetaTagsMap;
  feedTaggedArticle: (articleId: string, tags: string[]) => void;
  endTaggingPass: () => void;
  forceMetaSync: () => Promise<void>;
  metaSyncCooldownMs: number;
  metaStatus: MetaStatus;
  metaError: string | null;
  /** Set when `VITE_META_WORKER_URL` is missing at build time */
  metaEnvError: string | null;
}

export function useMetaWorker(articleIds: string[]): UseMetaWorkerResult {
  const [metaEnvError] = useState<string | null>(() =>
    WORKER_BASE ? null : missingWorkerEnvMessage('VITE_META_WORKER_URL'),
  );
  const [metaTagsMap, setMetaTagsMap] = useState<MetaTagsMap>(new Map());
  const [metaStatus, setMetaStatus] = useState<MetaStatus>(() => (WORKER_BASE ? 'active' : 'disabled'));
  const [metaError, setMetaError] = useState<string | null>(null);
  const [metaSyncCooldownMs, setMetaSyncCooldownMs] = useState(0);
  const circuitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cooldownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const syncInFlightRef = useRef(false);
  const rateLimitBackoffStepRef = useRef(0);
  const consecutiveErrorsRef = useRef(0);
  const blockedUntilRef = useRef(0);
  const articleIdsRef = useRef<string[]>(articleIds);
  const pendingBufferRef = useRef<Array<{ articleId: string; tags: string[] }>>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const FLUSH_INTERVAL_MS = 20_000;
  const MAX_BATCH = 200;

  // Keep visible article ids current for manual metadata pulls.
  useEffect(() => {
    articleIdsRef.current = articleIds;
  }, [articleIds]);

  const formatMetaSyncError = useCallback((e: unknown, fallback: string): string => {
    if (e instanceof TypeError && /Failed to fetch/i.test(e.message)) {
      return 'Could not reach shared metadata service (network/CORS).';
    }
    return e instanceof Error ? e.message : fallback;
  }, []);

  const registerFailure = useCallback((message: string) => {
    consecutiveErrorsRef.current += 1;
    setMetaStatus('error');
    setMetaError(message);
    if (consecutiveErrorsRef.current >= MAX_CONSECUTIVE_ERRORS) {
      const backoff = Math.min(
        BACKOFF_BASE_MS * 2 ** (consecutiveErrorsRef.current - MAX_CONSECUTIVE_ERRORS),
        BACKOFF_MAX_MS,
      );
      blockedUntilRef.current = Date.now() + backoff;
      if (circuitTimerRef.current) clearTimeout(circuitTimerRef.current);
      circuitTimerRef.current = setTimeout(() => {
        blockedUntilRef.current = 0;
      }, backoff);
    }
  }, []);

  const resetFailures = useCallback(() => {
    consecutiveErrorsRef.current = 0;
    blockedUntilRef.current = 0;
    if (circuitTimerRef.current) {
      clearTimeout(circuitTimerRef.current);
      circuitTimerRef.current = null;
    }
    setMetaError(null);
  }, []);

  const startMetaSyncCooldown = useCallback((durationMs = MANUAL_META_SYNC_COOLDOWN_MS) => {
    const cooldownUntil = Date.now() + durationMs;
    setMetaSyncCooldownMs(durationMs);
    if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
    cooldownTimerRef.current = setInterval(() => {
      const remaining = Math.max(0, cooldownUntil - Date.now());
      setMetaSyncCooldownMs(remaining);
      if (remaining <= 0 && cooldownTimerRef.current) {
        clearInterval(cooldownTimerRef.current);
        cooldownTimerRef.current = null;
      }
    }, 500);
  }, []);

  const applyRateLimitBackoff = useCallback((retryAfterMs?: number) => {
    const step = rateLimitBackoffStepRef.current;
    const expBackoffMs = Math.min(RATE_LIMIT_BACKOFF_BASE_MS * 2 ** step, RATE_LIMIT_BACKOFF_MAX_MS);
    const backoffMs = Math.max(retryAfterMs ?? 0, expBackoffMs);
    rateLimitBackoffStepRef.current = Math.min(step + 1, 20);
    blockedUntilRef.current = Date.now() + backoffMs;
    if (circuitTimerRef.current) clearTimeout(circuitTimerRef.current);
    circuitTimerRef.current = setTimeout(() => {
      blockedUntilRef.current = 0;
    }, backoffMs);
    setMetaStatus('active');
    setMetaError(`Shared metadata rate limited. Retrying allowed in ${Math.max(1, Math.ceil(backoffMs / 1000))}s.`);
    startMetaSyncCooldown(backoffMs);
  }, [startMetaSyncCooldown]);

  const syncNow = useCallback(async () => {
    if (!WORKER_BASE || syncInFlightRef.current) return;
    if (metaSyncCooldownMs > 0) return;
    if (blockedUntilRef.current && Date.now() < blockedUntilRef.current) return;
    syncInFlightRef.current = true;
    let rateLimited = false;
    setMetaStatus('syncing');
    try {
      const updates = await fetchMetaTags(WORKER_BASE, articleIdsRef.current);
      setMetaTagsMap(prev => {
        if (updates.length === 0) return prev;
        const next = new Map(prev);
        for (const u of updates) next.set(u.articleId, u.tags);
        return next;
      });
      resetFailures();
      rateLimitBackoffStepRef.current = 0;
      setMetaStatus('active');
    } catch (e) {
      if (e instanceof MetaRateLimitError) {
        rateLimited = true;
        applyRateLimitBackoff(e.retryAfterMs);
      } else {
        registerFailure(formatMetaSyncError(e, 'Meta sync failed'));
      }
    } finally {
      syncInFlightRef.current = false;
      if (!rateLimited) startMetaSyncCooldown();
    }
  }, [applyRateLimitBackoff, formatMetaSyncError, metaSyncCooldownMs, registerFailure, resetFailures, startMetaSyncCooldown]);

  const flush = useCallback(() => {
    if (pendingBufferRef.current.length === 0) return;
    const batch = pendingBufferRef.current.splice(0, MAX_BATCH);
    if (!WORKER_BASE) return;
    void submitMetaTags(WORKER_BASE, batch)
      .then(() => {
        resetFailures();
        rateLimitBackoffStepRef.current = 0;
        setMetaStatus('active');
      })
      .catch((e) => {
        pendingBufferRef.current.unshift(...batch);
        if (e instanceof MetaRateLimitError) {
          applyRateLimitBackoff(e.retryAfterMs);
          return;
        }
        registerFailure(formatMetaSyncError(e, 'Meta submit failed'));
      })
      .finally(() => {
        if (pendingBufferRef.current.length > 0) {
          flushTimerRef.current = setTimeout(flush, FLUSH_INTERVAL_MS);
        }
      });
  }, [applyRateLimitBackoff, formatMetaSyncError, registerFailure, resetFailures]);

  const stopFlushTimer = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, []);

  const feedTaggedArticle = useCallback((articleId: string, tags: string[]) => {
    pendingBufferRef.current.push({ articleId, tags });
    if (pendingBufferRef.current.length >= MAX_BATCH) {
      stopFlushTimer();
      flush();
      flushTimerRef.current = setTimeout(flush, FLUSH_INTERVAL_MS);
    } else if (!flushTimerRef.current) {
      flushTimerRef.current = setTimeout(flush, FLUSH_INTERVAL_MS);
    }
  }, [flush, stopFlushTimer]);

  const endTaggingPass = useCallback(() => {
    stopFlushTimer();
    flush();
  }, [flush, stopFlushTimer]);

  useEffect(() => () => {
    if (circuitTimerRef.current) clearTimeout(circuitTimerRef.current);
    if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
  }, []);

  return {
    metaTagsMap,
    feedTaggedArticle,
    endTaggingPass,
    forceMetaSync: syncNow,
    metaSyncCooldownMs,
    metaStatus,
    metaError,
    metaEnvError,
  };
}
