import { useState, useEffect, useRef, useCallback } from 'react';
import type { Article, ArticleTag, LabelHit, UserPrefs } from '../types';
import {
  createSyncRoom, fetchMeta, pushMeta, deleteRoom,
  buildPayload, mergePayload,
  autoSyncCompareKey,
  autoSyncCompareKeyFromPushedJson,
  type SyncRoom,
} from '../services/syncWorker';
import { PLATFORM_WORKER_URL, MISSING_PLATFORM_WORKER_MSG } from '../config/workerEnv';
import { syncDebugLog, isSyncDebugEnabled } from '../config/debugSync';
import { useSyncRoom } from './useSyncRoom';


const MANUAL_SYNC_COOLDOWN_MS = 15_000;
const DIRTY_SYNC_DEBOUNCE_MS = 1_000;
const RATE_LIMIT_BACKOFF_BASE_MS = 2_000;
const RATE_LIMIT_BACKOFF_MAX_MS = 5 * 60_000;
const RELINK_REQUIRED_MESSAGE =
  'Sync link expired or is invalid. Local sync was disabled to stop retries. Generate a new sync link.';

export type SyncStatus = 'idle' | 'active' | 'syncing' | 'error';

export interface SyncErrorDetails {
  phase: string;
  roomId: string | null;
  workerUrl: string | null;
  endpoint?: string;
}

export interface UseSyncWorkerResult {
  syncActive: boolean;
  syncStatus: SyncStatus;
  syncedAt: Date | null;
  syncError: string | null;
  syncErrorDetails: SyncErrorDetails | null;
  syncUrl: string | null;
  syncCooldownMs: number;
  forceSync: () => Promise<void>;
  generateLink: () => Promise<void>;
  revoke: () => Promise<void>;
  /** Non-null when `VITE_PLATFORM_WORKER_URL` is missing — needed to create new rooms; existing fragment/storage rooms still work */
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
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncErrorDetails, setSyncErrorDetails] = useState<SyncErrorDetails | null>(null);
  const [syncCooldownMs, setSyncCooldownMs] = useState(0);
  const [hasDirtyData, setHasDirtyData] = useState(false);

  const etagRef         = useRef<string>('');
  const lastPushedRef   = useRef<string>('');
  const syncInFlightRef = useRef(false);
  const cooldownUntilRef = useRef(0);
  const cooldownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const conflictRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const conflictDepthRef = useRef(0);
  const dirtyDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rateLimitBackoffStepRef = useRef(0);

  // forward ref for doPoll — updated after doPoll is defined below; return type is unknown so any doPoll signature fits
  const doPollRef = useRef<() => unknown>(async () => {});

  const { room, roomRef, syncUrl, consumedSyncHashRef, activate, clearRoom } = useSyncRoom(
    useCallback(() => { void doPollRef.current(); }, []),
  );

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

  const logSyncError = useCallback((
    phase: string,
    message: string,
    roomCtx?: SyncRoom | null,
    extra?: Record<string, unknown>,
  ) => {
    const endpoint = typeof extra?.endpoint === 'string' ? extra.endpoint : undefined;
    // Redact full roomId and workerUrl from console output — they are sensitive
    // tokens that should not appear in browser DevTools or log aggregators.
    const roomIdHint = roomCtx?.roomId ? `${roomCtx.roomId.slice(0, 6)}…` : null;
    const safeDetails = { phase, roomIdHint, endpoint };
    console.error(`[sync] ${message}`, safeDetails);
    // Full details go only to the in-memory debug log (never transmitted externally).
    syncDebugLog('saved', `${phase}:error`, {
      phase,
      roomId: roomCtx?.roomId ?? null,
      workerUrl: roomCtx?.workerUrl ?? null,
      endpoint,
      ...extra,
    });
    setSyncErrorDetails({
      phase,
      roomId: roomCtx?.roomId ?? null,
      workerUrl: roomCtx?.workerUrl ?? null,
      endpoint,
    });
  }, []);

  const startSyncCooldown = useCallback((durationMs = MANUAL_SYNC_COOLDOWN_MS) => {
    const until = Date.now() + durationMs;
    cooldownUntilRef.current = until;
    syncDebugLog('saved', 'cooldown:start', { durationMs });
    setSyncCooldownMs(durationMs);
    if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
    cooldownTimerRef.current = setInterval(() => {
      const remaining = Math.max(0, until - Date.now());
      setSyncCooldownMs(remaining);
      if (remaining <= 0 && cooldownTimerRef.current) {
        cooldownUntilRef.current = 0;
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

  const disableLocalSyncRoom = useCallback((message: string, roomForDisplay?: SyncRoom) => {
    clearRoom(roomForDisplay);
    setSyncStatus('error');
    setSyncedAt(null);
    setSyncError(message);
    setSyncErrorDetails(null);
    setSyncCooldownMs(0);
    setHasDirtyData(false);
    etagRef.current = '';
    lastPushedRef.current = '';
    syncInFlightRef.current = false;
    if (cooldownTimerRef.current) {
      clearInterval(cooldownTimerRef.current);
      cooldownTimerRef.current = null;
    }
  }, [clearRoom]);

  type MergedState = { prefs: UserPrefs; articleTags: ArticleTag[]; labelHits: LabelHit[]; savedArticles: Article[] };
  type PollResult = { status: 'ok'; merged: MergedState | null } | { status: 'blocked' | 'rate_limited' };

  const doPoll = useCallback(async (): Promise<PollResult> => {
    const r = roomRef.current;
    if (!r) return { status: 'blocked' };
    try {
      setSyncStatus('syncing');
      syncDebugLog('saved', 'poll:start', { roomId: r.roomId });
      const remote = await fetchMeta(r);
      if (remote?.unauthorized) {
        syncDebugLog('saved', 'poll:unauthorized', { roomId: r.roomId });
        logSyncError('poll', 'Unauthorized sync room/token during poll', r, {
          endpoint: `${r.workerUrl}/sync/${r.roomId}/meta`,
        });
        disableLocalSyncRoom(RELINK_REQUIRED_MESSAGE, r);
        return { status: 'blocked' };
      }
      if (remote?.rateLimited) {
        syncDebugLog('saved', 'poll:rate-limited', { roomId: r.roomId, retryAfterMs: remote.retryAfterMs });
        applyRateLimitBackoff(remote.retryAfterMs);
        return { status: 'rate_limited' };
      }
      let merged: MergedState | null = null;
      if (remote) {
        etagRef.current = remote.etag;
        const local: MergedState = { prefs: prefsRef.current, articleTags: articleTagsRef.current, labelHits: labelHitsRef.current, savedArticles: savedRef.current };
        merged = mergePayload(local, remote.payload);

        if (isSyncDebugEnabled()) {
          const newTags = merged.articleTags.filter(
            t => !local.articleTags.some(l => l.articleId === t.articleId && JSON.stringify([...l.tags].sort()) === JSON.stringify([...t.tags].sort())),
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
        }
        onMergeRef.current(merged);
      }
      setSyncedAt(new Date());
      // During a full manual sync, keep status in "syncing" until push completes.
      if (!syncInFlightRef.current) setSyncStatus('active');
      setSyncError(null);
      setSyncErrorDetails(null);
      if (consumedSyncHashRef.current) {
        history.replaceState(null, '', `${location.pathname}${location.search}`);
        consumedSyncHashRef.current = false;
      }
      rateLimitBackoffStepRef.current = 0;
      syncDebugLog('saved', 'poll:done', { roomId: r.roomId });
      return { status: 'ok', merged };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logSyncError('poll', message, r, {
        endpoint: `${r.workerUrl}/sync/${r.roomId}/meta`,
      });
      syncDebugLog('saved', 'poll:error', {
        roomId: r.roomId,
        error: message,
      });
      setSyncStatus('error');
      setSyncError(`Sync poll failed: ${message}`);
      return { status: 'blocked' };
    }
  }, [applyRateLimitBackoff, disableLocalSyncRoom, logSyncError]);

  // `data` is the already-merged state from doPoll; when provided, push that
  // instead of the current refs (which may still be pre-re-render stale values).
  const doPush = useCallback(async (data?: MergedState): Promise<'ok' | 'blocked' | 'rate_limited'> => {
    const r = roomRef.current;
    if (!r) return 'blocked';
    const prefs       = data?.prefs        ?? prefsRef.current;
    const articleTags = data?.articleTags  ?? articleTagsRef.current;
    const labelHits   = data?.labelHits    ?? labelHitsRef.current;
    const savedArts   = data?.savedArticles ?? savedRef.current;
    const payload = buildPayload(prefs, articleTags, labelHits, savedArts);
    const payloadJson = JSON.stringify(payload);
    const compareKey = autoSyncCompareKey(prefs, articleTags, labelHits, savedArts);
    const prevKey = lastPushedRef.current ? autoSyncCompareKeyFromPushedJson(lastPushedRef.current) : null;
    if (lastPushedRef.current && prevKey !== null && prevKey === compareKey) {
      syncDebugLog('saved', 'push:noop', { roomId: r.roomId });
      setSyncStatus('active');
      setHasDirtyData(false);
      return 'ok'; // nothing meaningful changed since last push (e.g. only seen/read churn)
    }
    setSyncStatus('syncing');
    syncDebugLog('saved', 'push:start', { roomId: r.roomId, etag: etagRef.current || null });
    const result = await pushMeta(r, payload, etagRef.current || undefined);
    if (result.conflict) {
      syncDebugLog('saved', 'push:conflict', { roomId: r.roomId });
      conflictDepthRef.current += 1;
      if (conflictDepthRef.current > 3) {
        conflictDepthRef.current = 0;
        syncDebugLog('saved', 'push:conflict-max-retry');
        return 'blocked';
      }
      // Remote is ahead — pull first, then push again after a short delay
      const pollResult = await doPoll();
      if (pollResult.status === 'ok') {
        if (conflictRetryRef.current) clearTimeout(conflictRetryRef.current);
        conflictRetryRef.current = setTimeout(() => {
          conflictRetryRef.current = null;
          void doPush(pollResult.merged ?? undefined);
        }, 500);
      }
      return 'blocked'; // don't mark as pushed — retry will re-check
    }
    conflictDepthRef.current = 0;
    if (result.unauthorized) {
      syncDebugLog('saved', 'push:unauthorized', { roomId: r.roomId });
      logSyncError('push', 'Unauthorized sync room/token during push', r, {
        endpoint: `${r.workerUrl}/sync/${r.roomId}/meta`,
      });
      disableLocalSyncRoom(RELINK_REQUIRED_MESSAGE, r);
      return 'blocked';
    }
    if (result.rateLimited) {
      syncDebugLog('saved', 'push:rate-limited', { roomId: r.roomId, retryAfterMs: result.retryAfterMs });
      applyRateLimitBackoff(result.retryAfterMs);
      return 'rate_limited';
    }
    if (!result.ok) {
      syncDebugLog('saved', 'push:failed', { roomId: r.roomId });
      logSyncError('push', 'PUT /sync/:roomId/meta failed', r, {
        endpoint: `${r.workerUrl}/sync/${r.roomId}/meta`,
      });
      setSyncStatus('error');
      setSyncError(`Could not upload changes to sync (PUT failed at ${r.workerUrl}).`);
      return 'blocked';
    }
    lastPushedRef.current = payloadJson;
    setSyncStatus('active');
    setSyncError(null);
    setSyncErrorDetails(null);
    setHasDirtyData(false);
    rateLimitBackoffStepRef.current = 0;
    syncDebugLog('saved', 'push:done', { roomId: r.roomId });
    return 'ok';
  }, [applyRateLimitBackoff, disableLocalSyncRoom, doPoll, logSyncError]);

  const forceSync = useCallback(async () => {
    if (!roomRef.current) {
      syncDebugLog('saved', 'force-sync:skip-no-room');
      return;
    }
    if (syncInFlightRef.current) {
      syncDebugLog('saved', 'force-sync:skip-in-flight');
      return;
    }
    const remainingCooldown = cooldownUntilRef.current - Date.now();
    if (remainingCooldown > 0) {
      syncDebugLog('saved', 'force-sync:skip-cooldown', { syncCooldownMs: remainingCooldown });
      return;
    }
    syncInFlightRef.current = true;
    let rateLimited = false;
    try {
      syncDebugLog('saved', 'force-sync:start');
      const pollResult = await doPoll();
      if (pollResult.status !== 'ok') {
        rateLimited = pollResult.status === 'rate_limited';
        return;
      }
      // Pass the merged state from poll directly to push so doPush uses the
      // post-merge data instead of stale refs (React state updates are async).
      const pushResult = await doPush(pollResult.merged ?? undefined);
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
  }, [doPoll, doPush, startSyncCooldown]);

  // Wire doPoll into the forward ref so useSyncRoom's on-activate callback can call it.
  doPollRef.current = doPoll;

  // Reset sync status/error when a room is activated (activate is called by useSyncRoom).
  useEffect(() => {
    if (!room) return;
    setSyncStatus('active');
    setSyncError(null);
    setSyncErrorDetails(null);
  }, [room]);

  // Track local data mutations and mark sync as dirty with a short debounce.
  useEffect(() => {
    if (!room || !syncReady) return;
    if (dirtyDebounceRef.current) clearTimeout(dirtyDebounceRef.current);
    dirtyDebounceRef.current = setTimeout(() => {
      const key = autoSyncCompareKey(
        prefsRef.current, articleTagsRef.current, labelHitsRef.current, savedRef.current,
      );
      let dirty: boolean;
      if (!lastPushedRef.current) {
        dirty = true;
      } else {
        const prevKey = autoSyncCompareKeyFromPushedJson(lastPushedRef.current);
        dirty = prevKey === null || prevKey !== key;
      }
      if (dirty) {
        syncDebugLog('saved', 'dirty:set', {
          reason: !lastPushedRef.current ? 'no-baseline-push-yet' : 'payload-changed',
        });
      } else if (isSyncDebugEnabled()) {
        const fullJson = JSON.stringify(
          buildPayload(
            prefsRef.current, articleTagsRef.current, labelHitsRef.current, savedRef.current,
          ),
        );
        const browseOnly =
          !!lastPushedRef.current &&
          fullJson !== lastPushedRef.current;
        if (browseOnly) {
          syncDebugLog('saved', 'dirty:clear (seen/read only; no auto-sync)');
        }
      }
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
  // Keyed on the boolean so the 500ms cooldown ticker doesn't re-run the
  // effect on every tick.
  const cooldownActive = syncCooldownMs > 0;
  useEffect(() => {
    if (!room || !syncReady || !hasDirtyData) return;
    if (syncInFlightRef.current || syncStatus === 'syncing' || cooldownActive) return;
    syncDebugLog('saved', 'dirty:auto-sync');
    void forceSync();
  }, [room, syncReady, hasDirtyData, syncStatus, cooldownActive, forceSync]);

  const generateLink = useCallback(async () => {
    const workerUrl = PLATFORM_WORKER_URL;
    if (!workerUrl) {
      const message = MISSING_PLATFORM_WORKER_MSG;
      logSyncError('generate-link', message, roomRef.current, { endpoint: '/sync/room' });
      setSyncError(message);
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
        logSyncError('generate-link', 'Unauthorized right after room creation', r, {
          endpoint: `${r.workerUrl}/sync/${r.roomId}/meta`,
        });
        disableLocalSyncRoom(RELINK_REQUIRED_MESSAGE);
        return;
      }
      if (!put.ok && !put.conflict) {
        logSyncError('generate-link', 'Initial sync upload failed', r, {
          endpoint: `${r.workerUrl}/sync/${r.roomId}/meta`,
        });
        setSyncStatus('error');
        setSyncError(`Initial sync upload failed at ${r.workerUrl}. Try Generate sync link again.`);
        return;
      }
      if (put.ok) {
        lastPushedRef.current = JSON.stringify(payload);
        setHasDirtyData(false);
      }
      setSyncStatus('active');
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to create sync room';
      logSyncError('generate-link', message, roomRef.current, {
        endpoint: `${workerUrl}/sync/room`,
      });
      setSyncStatus('error');
      setSyncError(`Generate link failed: ${message}`);
    }
  }, [activate, disableLocalSyncRoom, logSyncError]);

  const revoke = useCallback(async () => {
    const r = roomRef.current;
    if (r) {
      try { await deleteRoom(r); } catch { /* best effort */ }
    }
    clearRoom();
    setSyncStatus('idle');
    setSyncedAt(null);
    setSyncError(null);
    setSyncErrorDetails(null);
    setSyncCooldownMs(0);
    setHasDirtyData(false);
    etagRef.current = '';
    cooldownUntilRef.current = 0;
    conflictDepthRef.current = 0;
    if (conflictRetryRef.current) {
      clearTimeout(conflictRetryRef.current);
      conflictRetryRef.current = null;
    }
    if (cooldownTimerRef.current) {
      clearInterval(cooldownTimerRef.current);
      cooldownTimerRef.current = null;
    }
  }, [clearRoom]);

  useEffect(() => () => {
    if (cooldownTimerRef.current) {
      clearInterval(cooldownTimerRef.current);
      cooldownTimerRef.current = null;
    }
    if (conflictRetryRef.current) {
      clearTimeout(conflictRetryRef.current);
      conflictRetryRef.current = null;
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
    syncErrorDetails,
    syncUrl,
    syncCooldownMs,
    forceSync,
    generateLink,
    revoke,
    syncEnvError: PLATFORM_WORKER_URL ? null : MISSING_PLATFORM_WORKER_MSG,
  };
}
