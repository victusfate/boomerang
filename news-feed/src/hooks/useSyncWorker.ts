import { useState, useEffect, useRef, useCallback } from 'react';
import type { Article, ArticleTag, LabelHit, UserPrefs } from '../types';
import {
  loadSyncRoom, saveSyncRoom, clearSyncRoom, parseSyncFragment,
  createSyncRoom, fetchMeta, pushMeta, deleteRoom,
  buildSyncUrl, buildPayload, mergePayload,
  type SyncRoom,
} from '../services/syncWorker';
import { workerUrlFromEnv, missingWorkerEnvMessage } from '../config/workerEnv';

const SYNC_WORKER_BASE = workerUrlFromEnv(import.meta.env.VITE_SYNC_WORKER_URL);
const MANUAL_SYNC_COOLDOWN_MS = 15_000;
const RATE_LIMIT_BACKOFF_BASE_MS = 2_000;
const RATE_LIMIT_BACKOFF_MAX_MS = 5 * 60_000;
const SYNC_STATUS_LOG = '[sync:status]';

export type SyncStatus = 'idle' | 'active' | 'syncing' | 'error';

export interface UseSyncWorkerResult {
  syncActive: boolean;
  syncStatus: SyncStatus;
  syncedAt: Date | null;
  syncError: string | null;
  syncUrl: string | null;
  syncCooldownMs: number;
  forceSync: () => Promise<void>;
  generateLink: () => Promise<void>;
  revoke: () => Promise<void>;
  /** Non-null when `VITE_SYNC_WORKER_URL` is missing — needed to create new rooms; existing fragment/storage rooms still work */
  syncEnvError: string | null;
}

export function useSyncWorker(
  prefs: UserPrefs,
  articleTags: ArticleTag[],
  labelHits: LabelHit[],
  savedArticles: Article[],
  onMerge: (merged: {
    prefs: UserPrefs;
    articleTags: ArticleTag[];
    labelHits: LabelHit[];
    savedArticles: Article[];
  }) => void,
): UseSyncWorkerResult {
  const [room, setRoom]         = useState<SyncRoom | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncUrl, setSyncUrl]   = useState<string | null>(null);
  const [syncCooldownMs, setSyncCooldownMs] = useState(0);

  const etagRef         = useRef<string>('');
  const lastPushedRef   = useRef<string>('');
  const syncInFlightRef = useRef(false);
  const cooldownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rateLimitBackoffStepRef = useRef(0);
  const roomRef = useRef<SyncRoom | null>(null);
  // Keep in sync with `room` on every render; `activate` also sets the ref immediately so
  // `doPoll()` can run in the same tick as `activate` (before React commits `setRoom`).
  roomRef.current = room;

  // Keep latest state in refs so poll/push callbacks don't go stale
  const prefsRef        = useRef(prefs);
  const articleTagsRef  = useRef(articleTags);
  const labelHitsRef    = useRef(labelHits);
  const savedRef        = useRef(savedArticles);
  const onMergeRef      = useRef(onMerge);
  prefsRef.current       = prefs;
  articleTagsRef.current = articleTags;
  labelHitsRef.current   = labelHits;
  savedRef.current       = savedArticles;
  onMergeRef.current     = onMerge;

  const startSyncCooldown = useCallback((durationMs = MANUAL_SYNC_COOLDOWN_MS) => {
    console.info(SYNC_STATUS_LOG, 'cooldown:start', { durationMs });
    const cooldownUntil = Date.now() + durationMs;
    setSyncCooldownMs(durationMs);
    if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
    cooldownTimerRef.current = setInterval(() => {
      const remaining = Math.max(0, cooldownUntil - Date.now());
      setSyncCooldownMs(remaining);
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
    console.info(SYNC_STATUS_LOG, 'rate-limit:backoff', { step, retryAfterMs, backoffMs });
    startSyncCooldown(backoffMs);
    setSyncStatus('active');
    setSyncError(`Sync rate limited. Retrying allowed in ${Math.max(1, Math.ceil(backoffMs / 1000))}s.`);
  }, [startSyncCooldown]);

  const doPoll = useCallback(async (): Promise<'ok' | 'blocked' | 'rate_limited'> => {
    const r = roomRef.current;
    if (!r) return 'blocked';
    try {
      console.info(SYNC_STATUS_LOG, 'poll:start', { roomId: r.roomId });
      setSyncStatus('syncing');
      const remote = await fetchMeta(r);
      if (remote?.unauthorized) {
        console.info(SYNC_STATUS_LOG, 'poll:unauthorized');
        setSyncStatus('error');
        setSyncError('Sync room credentials are invalid or expired. Revoke sync and generate a new link.');
        return 'blocked';
      }
      if (remote?.rateLimited) {
        console.info(SYNC_STATUS_LOG, 'poll:rate-limited', { retryAfterMs: remote.retryAfterMs });
        applyRateLimitBackoff(remote.retryAfterMs);
        return 'rate_limited';
      }
      if (remote) {
        etagRef.current = remote.etag;
        const local = { prefs: prefsRef.current, articleTags: articleTagsRef.current, labelHits: labelHitsRef.current, savedArticles: savedRef.current };
        const merged = mergePayload(local, remote.payload);

        const newTags = merged.articleTags.filter(
          t => !local.articleTags.some(l => l.articleId === t.articleId && l.tags.join() === t.tags.join()),
        );
        const newSaved = merged.savedArticles.filter(
          a => !local.savedArticles.some(l => l.id === a.id),
        );
        const newSavedIds = merged.prefs.savedIds.filter(id => !local.prefs.savedIds.includes(id));
        console.info('[sync:sync-worker] poll merged', {
          newTaggedArticles: newTags.length,
          newSavedArticles: newSaved.length,
          newSavedIds: newSavedIds.length,
          newTagsSample: newTags.slice(0, 3).map(t => ({ articleId: t.articleId, tags: t.tags })),
          newSavedSample: newSaved.slice(0, 3).map(a => ({ id: a.id, title: a.title })),
        });

        onMergeRef.current(merged);
      }
      setSyncedAt(new Date());
      // During a full manual sync, keep status in "syncing" until push completes.
      if (!syncInFlightRef.current) setSyncStatus('active');
      setSyncError(null);
      rateLimitBackoffStepRef.current = 0;
      console.info(SYNC_STATUS_LOG, 'poll:done', { keptSyncingForFlow: syncInFlightRef.current });
      return 'ok';
    } catch (e) {
      console.info(SYNC_STATUS_LOG, 'poll:error', { message: e instanceof Error ? e.message : String(e) });
      setSyncStatus('error');
      setSyncError(e instanceof Error ? e.message : 'Sync failed');
      return 'blocked';
    }
  }, [applyRateLimitBackoff]);

  const doPush = useCallback(async (): Promise<'ok' | 'blocked' | 'rate_limited'> => {
    const r = roomRef.current;
    if (!r) return 'blocked';
    const payload = buildPayload(prefsRef.current, articleTagsRef.current, labelHitsRef.current, savedRef.current);
    const payloadJson = JSON.stringify(payload);
    if (payloadJson === lastPushedRef.current) {
      console.info(SYNC_STATUS_LOG, 'push:skip-noop');
      return 'ok'; // nothing changed since last push
    }
    setSyncStatus('syncing');
    console.info(SYNC_STATUS_LOG, 'push:start', { roomId: r.roomId });
    const result = await pushMeta(r, payload, etagRef.current || undefined);
    if (result.conflict) {
      console.info(SYNC_STATUS_LOG, 'push:conflict');
      // Remote is ahead — pull first, then push again after a short delay
      const pollResult = await doPoll();
      if (pollResult === 'ok') setTimeout(() => void doPush(), 500);
      return 'blocked'; // don't mark as pushed — retry will re-check
    }
    if (result.unauthorized) {
      console.info(SYNC_STATUS_LOG, 'push:unauthorized');
      setSyncStatus('error');
      setSyncError('Sync room credentials are invalid or expired. Revoke sync and generate a new link.');
      return 'blocked';
    }
    if (result.rateLimited) {
      console.info(SYNC_STATUS_LOG, 'push:rate-limited', { retryAfterMs: result.retryAfterMs });
      applyRateLimitBackoff(result.retryAfterMs);
      return 'rate_limited';
    }
    if (!result.ok) {
      console.info(SYNC_STATUS_LOG, 'push:error');
      setSyncStatus('error');
      setSyncError('Could not upload changes to sync (PUT failed). Check the Network tab for /meta.');
      return 'blocked';
    }
    lastPushedRef.current = payloadJson;
    setSyncStatus('active');
    setSyncError(null);
    rateLimitBackoffStepRef.current = 0;
    console.info(SYNC_STATUS_LOG, 'push:done');
    return 'ok';
  }, [applyRateLimitBackoff, doPoll]);

  const forceSync = useCallback(async () => {
    if (!roomRef.current) return;
    if (syncInFlightRef.current) {
      console.info(SYNC_STATUS_LOG, 'forceSync:skip-in-flight');
      return;
    }
    if (syncCooldownMs > 0) {
      console.info(SYNC_STATUS_LOG, 'forceSync:skip-cooldown', { remainingMs: syncCooldownMs });
      return;
    }
    console.info(SYNC_STATUS_LOG, 'forceSync:start');
    syncInFlightRef.current = true;
    let rateLimited = false;
    try {
      const pollResult = await doPoll();
      if (pollResult !== 'ok') {
        rateLimited = pollResult === 'rate_limited';
        return;
      }
      const pushResult = await doPush();
      if (pushResult !== 'ok') {
        rateLimited = pushResult === 'rate_limited';
        return;
      }
      // Full pull→merge→push flow completed (including noop push): finalize status.
      setSyncStatus('active');
    } finally {
      syncInFlightRef.current = false;
      if (!rateLimited) startSyncCooldown();
      console.info(SYNC_STATUS_LOG, 'forceSync:done', { rateLimited });
    }
  }, [doPoll, doPush, startSyncCooldown, syncCooldownMs]);

  // Activate sync with a room
  const activate = useCallback((r: SyncRoom) => {
    roomRef.current = r;
    setRoom(r);
    saveSyncRoom(r);
    setSyncStatus('active');
    setSyncError(null);
    if (SYNC_WORKER_BASE || r.workerUrl) {
      setSyncUrl(buildSyncUrl(r.workerUrl, r.roomId, r.token));
    }
  }, []);

  // On mount: check URL fragment first, then localStorage
  useEffect(() => {
    const fromFragment = parseSyncFragment();
    if (fromFragment) {
      activate(fromFragment);
      // Clean fragment from URL without reload
      history.replaceState(null, '', location.pathname + location.search);
      return;
    }
    const stored = loadSyncRoom();
    if (stored) activate(stored);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Pull once when a room is activated.
  useEffect(() => {
    if (!room) return;
    void doPoll();
    return undefined;
  }, [room, doPoll]);

  const generateLink = useCallback(async () => {
    const workerUrl = SYNC_WORKER_BASE;
    if (!workerUrl) {
      setSyncError(missingWorkerEnvMessage('VITE_SYNC_WORKER_URL'));
      return;
    }
    try {
      setSyncStatus('syncing');
      const r = await createSyncRoom(workerUrl);
      activate(r);
      // Push current state immediately so second device gets data on first poll
      const payload = buildPayload(prefsRef.current, articleTagsRef.current, labelHitsRef.current, savedRef.current);
      const put = await pushMeta(r, payload);
      if (put.unauthorized) {
        setSyncStatus('error');
        setSyncError('Sync room credentials are invalid or expired. Revoke sync and generate a new link.');
        return;
      }
      if (!put.ok && !put.conflict) {
        setSyncStatus('error');
        setSyncError('Initial sync upload failed. Try Generate sync link again.');
        return;
      }
      setSyncStatus('active');
    } catch (e) {
      setSyncStatus('error');
      setSyncError(e instanceof Error ? e.message : 'Failed to create sync room');
    }
  }, [activate]);

  const revoke = useCallback(async () => {
    const r = roomRef.current;
    if (r) {
      try { await deleteRoom(r); } catch { /* best effort */ }
    }
    clearSyncRoom();
    roomRef.current = null;
    setRoom(null);
    setSyncUrl(null);
    setSyncStatus('idle');
    setSyncedAt(null);
    setSyncError(null);
    setSyncCooldownMs(0);
    etagRef.current = '';
    if (cooldownTimerRef.current) {
      clearInterval(cooldownTimerRef.current);
      cooldownTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => {
    if (cooldownTimerRef.current) {
      clearInterval(cooldownTimerRef.current);
      cooldownTimerRef.current = null;
    }
  }, []);

  return {
    syncActive: !!room,
    syncStatus,
    syncedAt,
    syncError,
    syncUrl,
    syncCooldownMs,
    forceSync,
    generateLink,
    revoke,
    syncEnvError: SYNC_WORKER_BASE ? null : missingWorkerEnvMessage('VITE_SYNC_WORKER_URL'),
  };
}
