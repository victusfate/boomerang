export interface Env {
  // KV
  ARTICLE_META:   KVNamespace;
  REC_STORE:      KVNamespace;
  CAPTURE_TOKENS: KVNamespace;
  // R2
  SYNC_BLOCKS:  R2Bucket;
  // Durable Objects
  META_DO: DurableObjectNamespace;
  REC_DO:  DurableObjectNamespace;
  // Optional
  EXTRA_CORS_ORIGINS?: string;
  // Secrets
  GITHUB_PAT?: string;
}
