interface Env {
  ARTICLE_META: KVNamespace;
  META_DO: DurableObjectNamespace;
  /** Comma-separated `https://` origins (e.g. custom Cloudflare Pages domain). */
  EXTRA_CORS_ORIGINS?: string;
}
