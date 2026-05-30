/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Platform worker base URL (no trailing slash), e.g. https://boomerang-platform.xxx.workers.dev */
  readonly VITE_PLATFORM_WORKER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
