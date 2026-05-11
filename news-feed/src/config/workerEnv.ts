/** Help text appended to “missing VITE_*” errors for workers URLs. */
export const WORKER_ENV_HELP =
  'Copy news-feed/.env.example to news-feed/.env and set VITE_PLATFORM_WORKER_URL (or the individual VITE_RSS_WORKER_URL, VITE_META_WORKER_URL, VITE_SYNC_WORKER_URL, VITE_REC_WORKER_URL). Restart the dev server, or rebuild for production.';

export function missingWorkerEnvMessage(varName: string): string {
  return `Missing ${varName}. ${WORKER_ENV_HELP}`;
}

export function workerUrlFromEnv(raw: string | undefined): string {
  const s = (raw ?? '').replace(/\/$/, '').trim();
  return s;
}

/** Returns VITE_PLATFORM_WORKER_URL if set, otherwise falls back to the per-domain URL. */
export function resolveWorkerUrl(perDomainRaw: string | undefined): string {
  return workerUrlFromEnv(import.meta.env.VITE_PLATFORM_WORKER_URL || perDomainRaw);
}
