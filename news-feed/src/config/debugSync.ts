const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const ENV_DEBUG_SYNC = String(import.meta.env.VITE_DEBUG_SYNC ?? '').trim().toLowerCase();

function readRuntimeSyncDebugFlag(): boolean | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem('debug.sync');
    if (raw == null) return null;
    return TRUE_VALUES.has(raw.trim().toLowerCase());
  } catch {
    return null;
  }
}

export function isSyncDebugEnabled(): boolean {
  const runtimeOverride = readRuntimeSyncDebugFlag();
  if (runtimeOverride != null) return runtimeOverride;
  return TRUE_VALUES.has(ENV_DEBUG_SYNC);
}

export function syncDebugLog(scope: string, message: string, payload?: unknown): void {
  if (!isSyncDebugEnabled()) return;
  const prefix = `[sync:${scope}] ${message}`;
  if (payload === undefined) {
    console.info(prefix);
    return;
  }
  console.info(prefix, payload);
}
