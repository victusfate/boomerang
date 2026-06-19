import { useEffect, useRef } from 'react';

export function useVisibilitySync(
  forceMetaSync: () => void | Promise<void>,
  forceSync: (() => void | Promise<void>) | undefined,
  syncActive: boolean,
  syncReady: boolean,
): void {
  // Stable ref avoids the dep churn caused by the 500ms cooldown ticker
  // recreating forceMetaSync on every tick.
  const forceMetaSyncRef = useRef(forceMetaSync);
  forceMetaSyncRef.current = forceMetaSync;

  const initialSyncDoneRef = useRef(false);

  // On initial load, trigger a sync-worker pull+push for sync users.
  useEffect(() => {
    if (initialSyncDoneRef.current) return;
    if (!syncActive) return;
    if (!syncReady) return;
    initialSyncDoneRef.current = true;
    void forceSync?.();
  }, [syncActive, syncReady, forceSync]);

  // Re-fetch shared metadata (and full sync for sync users) when tab becomes active.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void forceMetaSyncRef.current();
      if (syncActive && syncReady) void forceSync?.();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [forceSync, syncActive, syncReady]);
}
