# PRD — Article metadata lookup

## Problem

The Rec diagnostics panel lists collaborative-filter **article IDs** with scores and feed-boost influence, but readers need **titles** to interpret rankings. Titles were attempted via:

- Local feed pool (`getArticleTitle`) — only covers articles currently in Fireproof / recent fetch.
- Misdirected `/bundle?include=<articleId>` — `include` expects **source** IDs, not article IDs.
- Early `REC_STORE` keys (`rec:article-meta:*`, 24h TTL) — separate from the 90-day tag store, not aligned with `ARTICLE_META`.

A failed client retry loop plus **synchronous full RSS hydrate** on every cache miss produced **~7s `/rec/articles` responses** and many repeated worker requests while the Rec tab was open.

## Solution (summary)

1. **Unified article record** in `ARTICLE_META` at `meta:<articleId>`: collaborative **tags** plus optional **catalog** fields (`title`, `source`, `sourceId`, `publishedAt`, `url`).
2. **Dedicated endpoint** `GET /rec/articles?ids=...` with bounded batch size, coverage metrics, and **KV-only** synchronous response.
3. **Background hydrate** on miss (`waitUntil`): bundle edge cache first, then RSS for remainder; persist back to `ARTICLE_META` with **6-month TTL**.
4. **Bundle prewarm** — every successful `/bundle` writes catalog rows in the background.
5. **Rec UI** — one-shot lookup for preview IDs, coverage line (`Resolved X/Y titles`), missing-title copy tied to shared TTL constant.

## User stories

1. **As a** reader on the Rec tab, **I want** article titles next to CF-ranked IDs when we have cached metadata, **so that** I can understand what the model is recommending.
2. **As a** reader, **I want** title lookup to complete quickly, **so that** opening Rec does not trigger multi-second worker work or repeated requests.
3. **As an** operator, **I want** article catalog retention aligned with long-lived tag storage (~months), **so that** metadata for interacted articles does not disappear after 24 hours.
4. **As a** developer, **I want** a single shared TTL constant for worker KV and UI copy, **so that** retention policy changes stay consistent.

## Implementation decisions

### Shared contract (`shared/articleRecordCatalog.ts`)

- `ARTICLE_RECORD_TTL_SECONDS` — canonical retention (180 days ≈ 6 months).
- `formatArticleCatalogCacheLabel()` — human duration for UI.
- `articleCatalogMissingTitleLabel()` — Rec missing-title string.

### Worker — record layer

- `platform-worker/src/domains/meta/articleRecord.ts` — KV key helpers, `catalogFromArticleRecord`, `mergeCatalogIntoRecord`.
- Tag writes in `meta/index.ts` and `MetaDO.ts` **preserve** catalog fields on merge.

### Worker — lookup (`platform-worker/src/domains/rec/articleMeta.ts`)

- `loadCachedArticleMeta` — read `ARTICLE_META` first; legacy `REC_STORE` fallback.
- `persistArticleMeta` — merge catalog into existing record; 6-month `expirationTtl`.
- `lookupArticleMetaByIds` — KV-only; no blocking RSS.
- `hydrateArticleMetaFromFeeds` — bundle cache scan, then staggered RSS; used from `waitUntil` only.

### Worker — routing (`platform-worker/src/domains/rec/index.ts`)

- `GET /rec/articles` — rate limit 30/min/IP; empty `ids` → 200 with zero counts.
- On `missing.length > 0`, schedule background hydrate with `defaultBundleCacheRequest(request)`.

### Worker — prewarm (`platform-worker/src/domains/rss/index.ts`)

- After `/bundle`, `ctx.waitUntil(persistArticleMeta(...))`.

### Client

- `news-feed/src/services/recArticlesLookup.ts` — parse `RecArticlesResponse`.
- `news-feed/src/services/recWorker.ts` — `fetchRecArticles()` returns full response.
- `news-feed/src/components/RecDiagnostics.tsx` — single-flight lookup; `articleCatalogMissingTitleLabel()` for fallback text; coverage hint with optional timing.

### Tests

- `platform-worker/src/domains/rec/articleMeta.node.test.ts` — key contract, normalization.
- `news-feed/src/services/recArticlesLookup.node.test.ts` — response parser.
- `news-feed/src/services/articleRecordCatalog.node.test.ts` — TTL label helpers.

## Testing strategy

- **Unit:** ID normalization cap (50), record/catalog parsing, response parser, TTL label formatting.
- **Manual:** Open Rec tab → one fast `/rec/articles`; no request storm. Load main feed → reopen Rec → titles improve. Wrangler logs show hydrate in background, not on critical path.
- **Regression:** Meta tag submit still preserves titles on existing catalog rows.

## Out of scope

- Storing titles inside ricochet / `REC_DO` interaction payloads.
- Per-source targeted RSS fetch for hydrate (v1 uses full default source set for remainder).
- Exposing catalog TTL via API (client uses shared constant; optional future field).
- Migrating or deleting all legacy `rec:article-meta:*` keys (lazy read fallback only).
