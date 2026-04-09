/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Cloudflare Worker base URL (no trailing slash), e.g. https://boomerang-rss.xxx.workers.dev */
  readonly VITE_RSS_WORKER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
