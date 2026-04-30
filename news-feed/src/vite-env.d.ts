/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** RSS Cloudflare Worker base URL (no trailing slash), e.g. https://boomerang-rss.xxx.workers.dev */
  readonly VITE_RSS_WORKER_URL?: string;
  /** Sync Cloudflare Worker base URL (no trailing slash), e.g. https://boomerang-sync.xxx.workers.dev */
  readonly VITE_SYNC_WORKER_URL?: string;
  /** Meta Cloudflare Worker base URL (no trailing slash), e.g. https://boomerang-meta.xxx.workers.dev */
  readonly VITE_META_WORKER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
