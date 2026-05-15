# TDD log — Article metadata lookup

## Slice status

| Slice | Description | Status |
|-------|-------------|--------|
| 1 | Shared TTL + `ArticleRecord` catalog fields | done |
| 2 | `GET /rec/articles` KV-fast lookup + coverage | done |
| 3 | `persistArticleMeta` + `/bundle` prewarm | done |
| 4 | Background hydrate (`waitUntil`, bundle cache → RSS) | done |
| 5 | RecDiagnostics client lookup + UI copy | done |
| 6 | Rate limit + unit tests | done |

---

## Slice 1 — Shared TTL + record shape

- **Status:** done
- `shared/articleRecordCatalog.ts`: `ARTICLE_RECORD_TTL_SECONDS` (180 days), `formatArticleCatalogCacheLabel`, `articleCatalogMissingTitleLabel`.
- `meta/articleRecord.ts`: `catalogFromArticleRecord`, `mergeCatalogIntoRecord`, `articleRecordKey` → `meta:<id>`.
- Tests: `articleRecordCatalog.node.test.ts` (6 months label); `articleMeta.node.test.ts` (TTL alignment).

## Slice 2 — `/rec/articles` endpoint

- **Status:** done
- `rec/index.ts`: rate limit `rec-articles` 30/min; empty ids → 200 zeros.
- `lookupArticleMetaByIds`: parallel KV read; preserve request order in `articles`.
- Tests: contract tests for normalize/dedupe/cap (50 ids).

## Slice 3 — Persist and prewarm

- **Status:** done
- `persistArticleMeta` writes `ARTICLE_META` with merge (tags preserved).
- `rss/index.ts`: `waitUntil(persistArticleMeta)` after bundle.
- `meta/index.ts` + `MetaDO.ts`: tag upserts preserve `title`, `source`, `url`, etc.

## Slice 4 — Background hydrate

- **Status:** done
- Removed synchronous `fetchFeedsStaggered` from request path (fix for ~7s latency).
- `hydrateArticleMetaFromFeeds`: `caches.default.match(bundle)` then RSS for remainder.
- `rec/index.ts`: `ctx.waitUntil(hydrate...)` when `missing.length > 0`.

## Slice 5 — Rec diagnostics client

- **Status:** done
- `recArticlesLookup.ts` + `fetchRecArticles` full response typing.
- `RecDiagnostics`: `previewKey`, `settledLookupIdsRef`, `inFlightLookupKeyRef` — fixes retry storm.
- Missing title: `articleCatalogMissingTitleLabel()` (not “local article pool”).
- Coverage: `Resolved X/Y titles` + optional timing from response.

## Slice 6 — Safeguards and tests

- **Status:** done
- `make test`: `news-feed` (incl. `recArticlesLookup`, `articleRecordCatalog`) + `platform-worker` (`articleMeta.node.test.ts`).
- Manual: verify single `/rec/articles` per Rec open; wrangler timings &lt;100ms on KV hit.

---

## Post-implementation fixes (branch)

| Fix | Description | Status |
|-----|-------------|--------|
| F1 | Stop sync RSS hydrate on `/rec/articles` (7s responses) | done |
| F2 | Client: cancel cleanup caused unsettled IDs → request loop | done |
| F3 | Move catalog from 24h `REC_STORE` to 6mo `ARTICLE_META` | done |
| F4 | Unified `meta:<id>` record; tag writes preserve catalog | done |
| F5 | Shared `articleRecordCatalog.ts` for worker TTL + UI label | done |

## Key files

| Area | Path |
|------|------|
| Shared TTL / UI labels | `shared/articleRecordCatalog.ts` |
| KV record helpers | `platform-worker/src/domains/meta/articleRecord.ts` |
| Lookup + hydrate | `platform-worker/src/domains/rec/articleMeta.ts` |
| Route | `platform-worker/src/domains/rec/index.ts` |
| Bundle prewarm | `platform-worker/src/domains/rss/index.ts` |
| Client parse | `news-feed/src/services/recArticlesLookup.ts` |
| Rec UI | `news-feed/src/components/RecDiagnostics.tsx` |
