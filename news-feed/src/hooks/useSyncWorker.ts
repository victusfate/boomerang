import { useState, useEffect, useRef, useCallback } from 'react';
import type { Article, ArticleTag, LabelHit, UserPrefs } from '../types';
import {
  loadSyncRoom, saveSyncRoom, clearSyncRoom, parseSyncFragment,
  createSyncRoom, fetchMeta, pushMeta, deleteRoom,
  buildSyncUrl, buildPayload, mergePayload,
  type SyncRoom,
} from '../services/syncWorker';

const POLL_INTERVAL_MS = 30_000;
const PUSH_DEBOUNCE_MS = 2_000;
const DEFAULT_BOOMERANG_SYNC_URL = 'https://boomerang-sync.boomerang.workers.dev';
const envSyncWorker = import.meta.env.VITE_SYNC_WORKER_URL?.replace(/\/$/, '') ?? '';
const WORKER_URL = envSyncWorker || (import.meta.env.PROD ? DEFAULT_BOOMERANG_SYNC_URL : undefined);

export type SyncStatus = 'idle' | 'active' | 'syncing' | 'error';

export interface UseSyncWorkerResult {
  syncActive: boolean;
  syncStatus: SyncStatus;
  syncedAt: Date | null;
  syncError: string | null;
  syncUrl: string | null;
  generateLink: () => Promise<void>;
  revoke: () => Promise<void>;
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

  const etagRef    = useRef<string>('');
  const pushTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimer  = useRef<ReturnType<typeof setInterval> | null>(null);
  const roomRef    = useRef<SyncRoom | null>(null);
  roomRef.current  = room;

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

  const doPoll = useCallback(async () => {
    const r = roomRef.current;
    if (!r) return;
    try {
      setSyncStatus('syncing');
      const remote = await fetchMeta(r);
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
      setSyncStatus('active');
      setSyncError(null);
    } catch (e) {
      setSyncStatus('error');
      setSyncError(e instanceof Error ? e.message : 'Sync failed');
    }
  }, []);

  const doPush = useCallback(async () => {
    const r = roomRef.current;
    if (!r) return;
    const payload = buildPayload(prefsRef.current, articleTagsRef.current, labelHitsRef.current, savedRef.current);
    const result = await pushMeta(r, payload, etagRef.current || undefined);
    if (result.conflict) {
      // Remote is ahead — pull first, then push again after a short delay
      await doPoll();
      setTimeout(() => void doPush(), 500);
    }
  }, [doPoll]);

  const schedulePush = useCallback(() => {
    if (!roomRef.current) return;
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(() => void doPush(), PUSH_DEBOUNCE_MS);
  }, [doPush]);

  // Activate sync with a room
  const activate = useCallback((r: SyncRoom) => {
    setRoom(r);
    saveSyncRoom(r);
    setSyncStatus('active');
    setSyncError(null);
    if (WORKER_URL || r.workerUrl) {
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
      void doPoll();
      return;
    }
    const stored = loadSyncRoom();
    if (stored) {
      activate(stored);
      void doPoll();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll on interval and on visibility change
  useEffect(() => {
    if (!room) return;

    pollTimer.current = setInterval(() => {
      if (document.visibilityState === 'visible') void doPoll();
    }, POLL_INTERVAL_MS);

    const onVisible = () => { if (document.visibilityState === 'visible') void doPoll(); };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [room, doPoll]);

  // Push on state change (debounced)
  useEffect(() => {
    if (!room) return;
    schedulePush();
  }, [prefs, articleTags, labelHits, savedArticles, room, schedulePush]);

  const generateLink = useCallback(async () => {
    const workerUrl = WORKER_URL;
    if (!workerUrl) { setSyncError('VITE_SYNC_WORKER_URL not configured'); return; }
    try {
      setSyncStatus('syncing');
      const r = await createSyncRoom(workerUrl);
      activate(r);
      // Push current state immediately so second device gets data on first poll
      const payload = buildPayload(prefsRef.current, articleTagsRef.current, labelHitsRef.current, savedRef.current);
      await pushMeta(r, payload);
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
    setRoom(null);
    setSyncUrl(null);
    setSyncStatus('idle');
    setSyncedAt(null);
    setSyncError(null);
    etagRef.current = '';
    if (pollTimer.current) clearInterval(pollTimer.current);
    if (pushTimer.current) clearTimeout(pushTimer.current);
  }, []);

  return {
    syncActive: !!room,
    syncStatus,
    syncedAt,
    syncError,
    syncUrl,
    generateLink,
    revoke,
  };
}
