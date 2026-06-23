# Boomerang Platform Worker — REST API

_v0.1.0 · generated 2026-06-23_

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

**Response:** `{ ok: true, service: "platform-worker" }`

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

**Request:** Query: `include` (comma-separated source IDs), `customFeeds` (base64-encoded JSON custom source list, max 20 feeds)

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

**Response:** `{ roomId: string, token: string }`

### **`GET`** `/sync/:roomId/blocks/:cid`

Read a sync block (Fireproof CID) from R2. `:roomId` is a 64-hex SHA-256; `:cid` is a base64url string.

**Response:** Raw block bytes, or 404.

### **`PUT`** `/sync/:roomId/blocks/:cid`

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

**Response:** `200` on success or `412 Precondition Failed` on ETag conflict.

### **`DELETE`** `/sync/:roomId`

Delete a sync room and all its R2 blocks.

**Auth:** Bearer token

**Response:** `{ ok: true }`

## Meta

### **`GET`** `/meta`

Look up article metadata (title, og:image, discussion URL) from KV cache.

**Rate limit:** Per-IP (30 req/min)

**Request:** Query: `ids` (comma-separated article IDs)

**Response:** `{ updates: ArticleRecord[] }`

### **`POST`** `/meta/tags`

Submit AI-generated topic tags for one or more articles; stored in MetaDO.

**Rate limit:** Per-IP (30 req/min)

**Request:** `{ articles: { articleId: string, tags: string[] }[] }` (max 6 tags per article)

**Response:** `{ ok: true }`

### **`GET`** `/ws`

Upgrade to WebSocket; receive live `tags` broadcasts from MetaDO.

**Response:** HTTP 101 Switching Protocols. Server pushes `{ type: "tags", articleId, tags }` messages.

## Rec

### **`POST`** `/interactions`

Ingest user interaction events for BiasedMF model training.

**Rate limit:** Per-IP (60 req/min)

**Request:** `{ events: InteractionEvent[] }` or bare `InteractionEvent[]` (max 200 events)

**Response:** `{ ok: true, queued: number }`

### **`GET`** `/recommendations/:userId`

Global ranked recommendations for a user (top-N from entire item catalogue).

**Rate limit:** Per-IP (30 req/min)

**Request:** Query: `limit` (default 50, max 500), `candidates` (optional comma-separated IDs)

**Response:** `RecResponse` — ranked `articleIds[]`, `scoredArticleIds[]`, `diagnostics`, `cache`, `timingMs`

> Cold-start users receive popularity-biased ranking.

### **`POST`** `/recommendations/:userId`

Feed-pool ranked recommendations — scores only the provided candidate articles.

**Rate limit:** Per-IP (30 req/min)

**Request:** `{ candidateArticleIds: string[], limit?: number, topicWeights?: Record<string, number> }`

**Response:** `RecResponse` — same shape as GET; `diagnostics.candidateStrategy` will be `"feed-pool"`.

> Preferred path for the news-feed client. Allows personalised topic weighting. Always returns full body (no 304).

### **`GET`** `/rec/articles`

Bulk article-metadata lookup from the KV ARTICLE_META catalogue.

**Rate limit:** Per-IP (30 req/min)

**Request:** Query: `ids` (comma-separated article IDs, max 50)

**Response:** `{ ok, requested, found, missing, articles: RecArticleMeta[] }`

### **`POST`** `/rec/articles`

Batch article-metadata lookup — body variant for large id sets (history backfill).

**Rate limit:** Per-IP (30 req/min, shared with GET)

**Request:** `{ ids: string[] }` — max 500 ids; 400 above the cap.

**Response:** Same shape as GET `/rec/articles`.

### **`GET`** `/rec/debug`

Internal model-state diagnostics (global mean, factor counts, KV counters).

**Response:** `{ globalState, userFactorsCount, itemFactorsCount, interactionsCount, kvCounters }`

> Unauthenticated. For internal/dev use only — gate behind auth before exposing publicly.

## Other

### **`POST`** `/api/capture/:captureToken`

Ingest a captured page (from the bookmarklet) to the token's configured destination.

**Auth:** Write-only capture token in the path; no bearer.

**Rate limit:** 60 captures/hour per token (KV).

**Request:** `text/plain` JSON body `{ url, title?, note?, source? }` (max 16 KB).

**Response:** `204 No Content` (also for unknown-url dedupe drops). `ACAO: *`.

> Unknown token → 401, invalid url → 400, over limit → 429. Duplicate url within 5 min is silently dropped (204).

### **`POST`** `/api/capture/token`

Generate or rotate the capture token for a room.

**Auth:** Bearer (room token, SHA-256 verified against `{roomId}/.token`).

**Request:** `{ roomId, destination }` where destination is `{ type: "saved-list" }` or `{ type: "github", owner, repo, path, branch }`.

**Response:** `{ captureToken }`

> Rotating deletes any prior token for the room.

### **`DELETE`** `/api/capture/token`

Revoke the capture token for a room.

**Auth:** Bearer (room token).

**Request:** `{ roomId }`

**Response:** `204 No Content`
