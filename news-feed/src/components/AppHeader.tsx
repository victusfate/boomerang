import type { SyncStatus } from '../hooks/useSyncWorker';
import { timeAgo } from '../services/timeAgo';

const MS_PER_SECOND = 1000;

export type SyncIndicatorState = 'idle' | 'setup' | 'active' | 'syncing' | 'error';

function formatCooldownLabel(remainingMs: number): string {
  return `Cooldown ${Math.max(1, Math.ceil(remainingMs / MS_PER_SECOND))}s`;
}

export function syncIndicatorState(
  syncActive: boolean,
  syncStatus: SyncStatus,
  metaStatus: 'disabled' | 'active' | 'syncing' | 'error',
  syncedAt: Date | null,
  syncError: string | null,
  syncEnvError: string | null,
  cooldownMs: number,
): { state: SyncIndicatorState; label: string; title: string } {
  if (syncError || syncStatus === 'error') {
    return { state: 'error', label: 'Sync error', title: syncError ?? 'Sync failed' };
  }
  if (syncStatus === 'syncing' || metaStatus === 'syncing') {
    return { state: 'syncing', label: 'Syncing...', title: 'Pulling or pushing sync data' };
  }
  if (cooldownMs > 0) {
    return {
      state: 'active',
      label: formatCooldownLabel(cooldownMs),
      title: `Sync cooldown active (${Math.ceil(cooldownMs / MS_PER_SECOND)}s remaining)`,
    };
  }
  if (syncActive) {
    const label = syncedAt ? `Synced ${timeAgo(syncedAt, 'ago')}` : 'Sync on';
    return { state: 'active', label, title: 'Sync is active.' };
  }
  if (syncEnvError) {
    return { state: 'setup', label: 'Sync setup', title: syncEnvError };
  }
  return { state: 'idle', label: 'Sync off', title: 'Sync is not active. Open Settings to generate a sync link.' };
}

export function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      style={{ animation: spinning ? 'spin 1s linear infinite' : 'none' }}
      aria-hidden="true"
    >
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}
