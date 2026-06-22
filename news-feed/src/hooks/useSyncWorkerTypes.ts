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
