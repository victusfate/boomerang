import { useState, useEffect, useRef, useCallback } from 'react';
import type { Article, ArticleTag, LabelHit, UserPrefs } from '../types';
import {
  loadSyncRoom, saveSyncRoom, clearSyncRoom, parseSyncFragment,
  createSyncRoom, fetchMeta, pushMeta, deleteRoom,
  buildSyncUrl, buildPayload, mergePayload,
  type SyncRoom,
} from '../services/syncWorker';
import { workerUrlFromEnv, missingWorkerEnvMessage } from '../config/workerEnv';
import { syncDebugLog } from '../config/debugSync';

const SYNC_WORKER_BASE = workerUrlFromEnv(import.meta.env.VITE_SYNC_WORKER_URL);
const MANUAL_SYNC_COOLDOWN_MS = 15_000;
const DIRTY_SYNC_DEBOUNCE_MS = 1_000;
const RATE_LIMIT_BACKOFF_BASE_MS = 2_000;
const RATE_LIMIT_BACKOFF_MAX_MS = 5 * 60_000;

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
  syncReady = true,
): UseSyncWorkerResult {
  const [room, setRoom]         = useState<SyncRoom | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncUrl, setSyncUrl]   = useState<string | null>(null);
  const [syncCooldownMs, setSyncCooldownMs] = useState(0);
  const [hasDirtyData, setHasDirtyData] = useState(false);

  const etagRef         = useRef<string>('');
  const lastPushedRef   = useRef<string>('');
  const syncInFlightRef = useRef(false);
  const cooldownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dirtyDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    const cooldownUntil = Date.now() + durationMs;
    syncDebugLog('saved', 'cooldown:start', { durationMs });
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
    syncDebugLog('saved', 'rate-limit:backoff', { retryAfterMs, backoffMs, step });
    rateLimitBackoffStepRef.current = Math.min(step + 1, 20);
    startSyncCooldown(backoffMs);
    setSyncStatus('active');
    setSyncError(`Sync rate limited. Retrying allowed in ${Math.max(1, Math.ceil(backoffMs / 1000))}s.`);
  }, [startSyncCooldown]);

  const doPoll = useCallback(async (): Promise<'ok' | 'blocked' | 'rate_limited'> => {
    const r = roomRef.current;
    if (!r) return 'blocked';
    try {
      setSyncStatus('syncing');
      syncDebugLog('saved', 'poll:start', { roomId: r.roomId });
      const remote = await fetchMeta(r);
      if (remote?.unauthorized) {
        syncDebugLog('saved', 'poll:unauthorized', { roomId: r.roomId });
        setSyncStatus('error');
        setSyncError('Sync room credentials are invalid or expired. Revoke sync and generate a new link.');
        return 'blocked';
      }
      if (remote?.rateLimited) {
        syncDebugLog('saved', 'poll:rate-limited', { roomId: r.roomId, retryAfterMs: remote.retryAfterMs });
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
        syncDebugLog('saved', 'poll:merged', {
          roomId: r.roomId,
          etag: remote.etag,
          newTags: newTags.length,
          newSaved: newSaved.length,
          newSavedIds: newSavedIds.length,
        });
        onMergeRef.current(merged);
      }
      setSyncedAt(new Date());
      // During a full manual sync, keep status in "syncing" until push completes.
      if (!syncInFlightRef.current) setSyncStatus('active');
      setSyncError(null);
      rateLimitBackoffStepRef.current = 0;
      syncDebugLog('saved', 'poll:done', { roomId: r.roomId });
      return 'ok';
    } catch (e) {
      syncDebugLog('saved', 'poll:error', {
        roomId: r.roomId,
        error: e instanceof Error ? e.message : String(e),
      });
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
      syncDebugLog('saved', 'push:noop', { roomId: r.roomId });
      setSyncStatus('active');
      setHasDirtyData(false);
      return 'ok'; // nothing changed since last push
    }
    setSyncStatus('syncing');
    syncDebugLog('saved', 'push:start', { roomId: r.roomId, etag: etagRef.current || null });
    const result = await pushMeta(r, payload, etagRef.current || undefined);
    if (result.conflict) {
      syncDebugLog('saved', 'push:conflict', { roomId: r.roomId });
      // Remote is ahead — pull first, then push again after a short delay
      const pollResult = await doPoll();
      if (pollResult === 'ok') setTimeout(() => void doPush(), 500);
      return 'blocked'; // don't mark as pushed — retry will re-check
    }
    if (result.unauthorized) {
      syncDebugLog('saved', 'push:unauthorized', { roomId: r.roomId });
      setSyncStatus('error');
      setSyncError('Sync room credentials are invalid or expired. Revoke sync and generate a new link.');
      return 'blocked';
    }
    if (result.rateLimited) {
      syncDebugLog('saved', 'push:rate-limited', { roomId: r.roomId, retryAfterMs: result.retryAfterMs });
      applyRateLimitBackoff(result.retryAfterMs);
      return 'rate_limited';
    }
    if (!result.ok) {
      syncDebugLog('saved', 'push:failed', { roomId: r.roomId });
      setSyncStatus('error');
      setSyncError('Could not upload changes to sync (PUT failed). Check the Network tab for /meta.');
      return 'blocked';
    }
    lastPushedRef.current = payloadJson;
    setSyncStatus('active');
    setSyncError(null);
    setHasDirtyData(false);
    rateLimitBackoffStepRef.current = 0;
    syncDebugLog('saved', 'push:done', { roomId: r.roomId });
    return 'ok';
  }, [applyRateLimitBackoff, doPoll]);

  const forceSync = useCallback(async () => {
    if (!roomRef.current) {
      syncDebugLog('saved', 'force-sync:skip-no-room');
      return;
    }
    if (syncInFlightRef.current) {
      syncDebugLog('saved', 'force-sync:skip-in-flight');
      return;
    }
    if (syncCooldownMs > 0) {
      syncDebugLog('saved', 'force-sync:skip-cooldown', { syncCooldownMs });
      return;
    }
    syncInFlightRef.current = true;
    let rateLimited = false;
    try {
      syncDebugLog('saved', 'force-sync:start');
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
      syncDebugLog('saved', 'force-sync:done');
    } finally {
      syncInFlightRef.current = false;
      if (!rateLimited) startSyncCooldown();
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

  // Track local data mutations and mark sync as dirty with a short debounce.
  useEffect(() => {
    if (!room || !syncReady) return;
    if (dirtyDebounceRef.current) clearTimeout(dirtyDebounceRef.current);
    dirtyDebounceRef.current = setTimeout(() => {
      const payload = buildPayload(prefsRef.current, articleTagsRef.current, labelHitsRef.current, savedRef.current);
      const payloadJson = JSON.stringify(payload);
      const dirty = payloadJson !== lastPushedRef.current;
      setHasDirtyData(dirty);
    }, DIRTY_SYNC_DEBOUNCE_MS);
    return () => {
      if (dirtyDebounceRef.current) {
        clearTimeout(dirtyDebounceRef.current);
        dirtyDebounceRef.current = null;
      }
    };
  }, [room, syncReady, prefs, articleTags, labelHits, savedArticles]);

  // Auto-fire one sync run when there is dirty data and blockout clears.
  useEffect(() => {
    if (!room || !syncReady || !hasDirtyData) return;
    if (syncInFlightRef.current || syncStatus === 'syncing' || syncCooldownMs > 0) return;
    syncDebugLog('saved', 'dirty:auto-sync');
    void forceSync();
  }, [room, syncReady, hasDirtyData, syncStatus, syncCooldownMs, forceSync]);

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
    setHasDirtyData(false);
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
    if (dirtyDebounceRef.current) {
      clearTimeout(dirtyDebounceRef.current);
      dirtyDebounceRef.current = null;
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
