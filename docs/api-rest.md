# Boomerang Platform Worker — REST API

_v0.1.0 · generated 2026-05-29_

<!-- Generated from `platform-worker/src/apiRoutes.ts` — do not edit by hand. -->

## Base URL

Configured via `wrangler.jsonc`. All routes are CORS-enabled for configured origins.

## Authentication

Routes marked **Auth: Bearer token** require an `Authorization: Bearer <token>` header
where `<token>` is the room token issued by `POST /sync/room`.

## Rate Limiting

Per-IP rate limits are enforced via an in-isolate sliding window.
Exceeding a limit returns **429 Too Many Requests** with a `Retry-After` header.

---

## Health

### **`GET`** `/health`

Worker liveness check.

**Response:** `{ ok: true, domain: "worker" }`

### **`GET`** `/health/rss`

RSS domain liveness check.

**Response:** `{ ok: true, domain: "rss" }`

### **`GET`** `/health/sync`

Sync domain liveness check.

**Response:** `{ ok: true, domain: "sync" }`

### **`GET`** `/health/meta`

Meta domain liveness check.

**Response:** `{ ok: true, domain: "meta" }`

### **`GET`** `/health/rec`

Rec domain liveness check.

**Response:** `{ ok: true, domain: "rec" }`

## RSS

### **`GET`** `/bundle`

Fetch and merge articles from multiple RSS/Atom feeds.

**Request:** Query: `include` (comma-separated source IDs), `customFeeds` (base64 gzip-encoded custom source list)

**Response:** `{ articles: Article[] }`

> Sources are sorted by feed URL to maximise CDN cache hit rate. YouTube and non-YouTube sources are fetched in separate tiers.

### **`GET`** `/og-image`

Proxy and cache an og:image URL for a given article URL.

**Request:** Query: `url` (article URL to extract og:image from)

**Response:** Image bytes (passthrough), or `{ ok: false }` on failure.

> Only http/https URLs are fetched. Redirects are followed with re-validation (SSRF guard).

### **`GET`** `/image`

Proxy and cache a raw image URL.

**Request:** Query: `url` (direct image URL)

**Response:** Image bytes (passthrough), or `{ ok: false }` on failure.

## Sync

### **`POST`** `/sync/room`

Create a new sync room and return its credentials.

**Rate limit:** Per-IP

**Request:** Empty body or `{}`

**Response:** `{ roomId: string, token: string, workerUrl: string }`

### **`GET`** `/sync/:roomId/:block`

Read a sync block (Fireproof CID block) from R2.

**Response:** Raw block bytes, or 404.

### **`PUT`** `/sync/:roomId/:block`

Write a sync block to R2.

**Auth:** Bearer token (SHA-256 of room token)

**Response:** `{ ok: true }`

### **`GET`** `/sync/:roomId/meta`

Read room metadata (UserPrefs + savedArticles snapshot).

**Response:** JSON payload with `ETag` header for conditional requests.

### **`PUT`** `/sync/:roomId/meta`

Write room metadata; supports `If-Match` for optimistic concurrency.

**Auth:** Bearer token

**Request:** JSON payload: `{ prefs, savedArticles, articleTags, labelHits }`

**Response:** `{ ok: true }` or 409 on ETag conflict.

### **`DELETE`** `/sync/:roomId`

Delete a sync room and all its R2 blocks.

**Auth:** Bearer token

**Response:** `{ ok: true }`

## Meta

### **`GET`** `/meta`

Look up article metadata (title, og:image, discussion URL) from KV cache.

**Rate limit:** Per-IP (30 req/min)

**Request:** Query: `ids` (comma-separated article IDs, max 50)

**Response:** `{ ok: true, found: number, missing: string[], articles: ArticleRecord[] }`

### **`POST`** `/meta/tags`

Submit AI-generated topic tags for one or more articles; stored in MetaDO.

**Rate limit:** Per-IP (30 req/min)

**Request:** `{ articleId: string, tags: string[] }[]` (max 6 tags per article)

**Response:** `{ ok: true, accepted: number }`

### **`GET`** `/ws`

Upgrade to WebSocket; receive live `tags` broadcasts from MetaDO.

**Response:** HTTP 101 Switching Protocols. Server pushes `{ type: "tags", articleId, tags }` messages.

## Rec

### **`POST`** `/interactions`

Ingest user interaction events for BiasedMF model training.

**Rate limit:** Per-IP (60 req/min)

**Request:** `{ events: InteractionEvent[] }` or bare `InteractionEvent[]` (max 200)

**Response:** `{ ok: true, queued: number }`

### **`GET`** `/recommendations/:userId`

Global ranked recommendations for a user (top-N from entire item catalogue).

**Rate limit:** Per-IP (30 req/min)

**Request:** Query: `limit` (default 50, max 200), `candidates` (optional comma-separated IDs)

**Response:** `RecResponse` — ranked `articleIds[]`, `scoredArticleIds[]`, `diagnostics`, `cache`, `timingMs`

> Cold-start users receive popularity-biased ranking. Supports `If-None-Match` / `ETag` (GET only).

### **`POST`** `/recommendations/:userId`

Feed-pool ranked recommendations — scores only the provided candidate articles.

**Rate limit:** Per-IP (30 req/min)

**Request:** `{ candidateArticleIds: string[], limit?: number, topicWeights?: Record<string, number> }`

**Response:** `RecResponse` — same shape as GET; `diagnostics.candidateStrategy` will be `"feed-pool"`.

> Preferred path for the news-feed client. Allows personalised topic weighting. Always returns full body (no 304).

### **`GET`** `/rec/articles`

Bulk article-metadata lookup from the KV ARTICLE_META catalogue.

**Rate limit:** Per-IP (30 req/min)

**Request:** Query: `ids` (comma-separated article IDs)

**Response:** `{ ok, requested, found, missing, articles: RecArticleMeta[] }`

### **`GET`** `/rec/debug`

Internal model-state diagnostics (global mean, factor counts, KV counters).

**Response:** `{ globalState, userFactorsCount, itemFactorsCount, interactionsCount, kvCounters }`

> Unauthenticated. For internal/dev use only — gate behind auth before exposing publicly.
