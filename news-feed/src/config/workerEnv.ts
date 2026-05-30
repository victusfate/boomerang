const raw = (import.meta.env.VITE_PLATFORM_WORKER_URL ?? '').replace(/\/$/, '').trim();

/** Platform worker base URL (no trailing slash). Empty string when unset. */
export const PLATFORM_WORKER_URL: string = raw;

export const MISSING_PLATFORM_WORKER_MSG =
  'Missing VITE_PLATFORM_WORKER_URL. Copy news-feed/.env.example to news-feed/.env and set VITE_PLATFORM_WORKER_URL. Restart the dev server, or rebuild for production.';
