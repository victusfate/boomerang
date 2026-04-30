interface Env {
  /** Comma-separated `https://` origins (e.g. custom Cloudflare Pages domain). */
  EXTRA_CORS_ORIGINS?: string;
  /** Shared article metadata KV namespace (same as meta-worker). */
  ARTICLE_META?: KVNamespace;
}
