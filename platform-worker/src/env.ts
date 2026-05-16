export interface Env {
  // KV
  ARTICLE_META: KVNamespace;
  REC_STORE:    KVNamespace;
  // R2
  SYNC_BLOCKS:  R2Bucket;
  // Durable Objects
  META_DO: DurableObjectNamespace;
  REC_DO:  DurableObjectNamespace;
  // Optional
  EXTRA_CORS_ORIGINS?: string;
  /** When PAUSE_REC_RANK_KV is false in rec/index.ts: set "1"/"true" to cache global (no pool) rankings in REC_STORE. */
  REC_ENABLE_RANK_KV?: string;
}
