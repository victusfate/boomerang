/** Typed route registry — single source of truth for the HTTP REST API surface. */

export interface RouteDoc {
  method: string | string[];
  path: string;
  summary: string;
  auth?: string;
  rateLimit?: string;
  request?: string;
  response: string;
  notes?: string;
}

/** @internal */
export const API_ROUTES: RouteDoc[] = [
  // ── Health ────────────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/health',
    summary: 'Worker liveness check.',
    response: '`{ ok: true, domain: "worker" }`',
  },
  {
    method: 'GET',
    path: '/health/rss',
    summary: 'RSS domain liveness check.',
    response: '`{ ok: true, domain: "rss" }`',
  },
  {
    method: 'GET',
    path: '/health/sync',
    summary: 'Sync domain liveness check.',
    response: '`{ ok: true, domain: "sync" }`',
  },
  {
    method: 'GET',
    path: '/health/meta',
    summary: 'Meta domain liveness check.',
    response: '`{ ok: true, domain: "meta" }`',
  },
  {
    method: 'GET',
    path: '/health/rec',
    summary: 'Rec domain liveness check.',
    response: '`{ ok: true, domain: "rec" }`',
  },

  // ── RSS domain ────────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/bundle',
    summary: 'Fetch and merge articles from multiple RSS/Atom feeds.',
    request: 'Query: `include` (comma-separated source IDs), `customFeeds` (base64 gzip-encoded custom source list)',
    response: '`{ articles: Article[] }`',
    notes: 'Sources are sorted by feed URL to maximise CDN cache hit rate. YouTube and non-YouTube sources are fetched in separate tiers.',
  },
  {
    method: 'GET',
    path: '/og-image',
    summary: 'Proxy and cache an og:image URL for a given article URL.',
    request: 'Query: `url` (article URL to extract og:image from)',
    response: 'Image bytes (passthrough), or `{ ok: false }` on failure.',
    notes: 'Only http/https URLs are fetched. Redirects are followed with re-validation (SSRF guard).',
  },
  {
    method: 'GET',
    path: '/image',
    summary: 'Proxy and cache a raw image URL.',
    request: 'Query: `url` (direct image URL)',
    response: 'Image bytes (passthrough), or `{ ok: false }` on failure.',
  },

  // ── Sync domain ───────────────────────────────────────────────────────────
  {
    method: 'POST',
    path: '/sync/room',
    summary: 'Create a new sync room and return its credentials.',
    rateLimit: 'Per-IP',
    request: 'Empty body or `{}`',
    response: '`{ roomId: string, token: string, workerUrl: string }`',
  },
  {
    method: 'GET',
    path: '/sync/:roomId/blocks/:cid',
    summary: 'Read a sync block (Fireproof CID) from R2. `:roomId` is a 64-hex SHA-256; `:cid` is a base64url string.',
    response: 'Raw block bytes, or 404.',
  },
  {
    method: 'PUT',
    path: '/sync/:roomId/blocks/:cid',
    summary: 'Write a sync block to R2.',
    auth: 'Bearer token (SHA-256 of room token)',
    response: '`{ ok: true }`',
  },
  {
    method: 'GET',
    path: '/sync/:roomId/meta',
    summary: 'Read room metadata (UserPrefs + savedArticles snapshot).',
    response: 'JSON payload with `ETag` header for conditional requests.',
  },
  {
    method: 'PUT',
    path: '/sync/:roomId/meta',
    summary: 'Write room metadata; supports `If-Match` for optimistic concurrency.',
    auth: 'Bearer token',
    request: 'JSON payload: `{ prefs, savedArticles, articleTags, labelHits }`',
    response: '`{ ok: true }` or 409 on ETag conflict.',
  },
  {
    method: 'DELETE',
    path: '/sync/:roomId',
    summary: 'Delete a sync room and all its R2 blocks.',
    auth: 'Bearer token',
    response: '`{ ok: true }`',
  },

  // ── Meta domain ───────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/meta',
    summary: 'Look up article metadata (title, og:image, discussion URL) from KV cache.',
    rateLimit: 'Per-IP (30 req/min)',
    request: 'Query: `ids` (comma-separated article IDs)',
    response: '`{ updates: ArticleRecord[] }`',
  },
  {
    method: 'POST',
    path: '/meta/tags',
    summary: 'Submit AI-generated topic tags for one or more articles; stored in MetaDO.',
    rateLimit: 'Per-IP (30 req/min)',
    request: '`{ articles: { articleId: string, tags: string[] }[] }` (max 6 tags per article)',
    response: '`{ ok: true }`',
  },
  {
    method: 'GET',
    path: '/ws',
    summary: 'Upgrade to WebSocket; receive live `tags` broadcasts from MetaDO.',
    response: 'HTTP 101 Switching Protocols. Server pushes `{ type: "tags", articleId, tags }` messages.',
  },

  // ── Rec domain ────────────────────────────────────────────────────────────
  {
    method: 'POST',
    path: '/interactions',
    summary: 'Ingest user interaction events for BiasedMF model training.',
    rateLimit: 'Per-IP (60 req/min)',
    request: '`{ events: InteractionEvent[] }` or bare `InteractionEvent[]` (max 200 events)',
    response: '`{ ok: true, queued: number }`',
  },
  {
    method: 'GET',
    path: '/recommendations/:userId',
    summary: 'Global ranked recommendations for a user (top-N from entire item catalogue).',
    rateLimit: 'Per-IP (30 req/min)',
    request: 'Query: `limit` (default 50, max 500), `candidates` (optional comma-separated IDs)',
    response: '`RecResponse` — ranked `articleIds[]`, `scoredArticleIds[]`, `diagnostics`, `cache`, `timingMs`',
    notes: 'Cold-start users receive popularity-biased ranking.',
  },
  {
    method: 'POST',
    path: '/recommendations/:userId',
    summary: 'Feed-pool ranked recommendations — scores only the provided candidate articles.',
    rateLimit: 'Per-IP (30 req/min)',
    request: '`{ candidateArticleIds: string[], limit?: number, topicWeights?: Record<string, number> }`',
    response: '`RecResponse` — same shape as GET; `diagnostics.candidateStrategy` will be `"feed-pool"`.',
    notes: 'Preferred path for the news-feed client. Allows personalised topic weighting. Always returns full body (no 304).',
  },
  {
    method: 'GET',
    path: '/rec/articles',
    summary: 'Bulk article-metadata lookup from the KV ARTICLE_META catalogue.',
    rateLimit: 'Per-IP (30 req/min)',
    request: 'Query: `ids` (comma-separated article IDs)',
    response: '`{ ok, requested, found, missing, articles: RecArticleMeta[] }`',
  },
  {
    method: 'GET',
    path: '/rec/debug',
    summary: 'Internal model-state diagnostics (global mean, factor counts, KV counters).',
    response: '`{ globalState, userFactorsCount, itemFactorsCount, interactionsCount, kvCounters }`',
    notes: 'Unauthenticated. For internal/dev use only — gate behind auth before exposing publicly.',
  },
];
