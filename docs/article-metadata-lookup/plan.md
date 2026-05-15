# Plan — Article metadata lookup

Vertical slices (tracer bullets). Status reflects branch implementation.

## Slice 1 — Catalog contract and shared TTL

- Add `shared/articleRecordCatalog.ts` with `ARTICLE_RECORD_TTL_SECONDS` and label helpers.
- Extend `ArticleRecord` in `meta/articleRecord.ts` with optional catalog fields.
- **Done:** Worker and news-feed import shared TTL; tests in `articleRecordCatalog.node.test.ts`.

## Slice 2 — `/rec/articles` endpoint (KV-fast)

- `normalizeIdsParam`, `lookupArticleMetaByIds`, route in `rec/index.ts` and `platform-worker/src/index.ts`.
- Response: `articles`, `requested`, `found`, `missing`, `timingMs`.
- **Done:** No synchronous RSS on request path.

## Slice 3 — Persist and prewarm

- `persistArticleMeta` → `ARTICLE_META` `meta:<id>` (merge tags + catalog).
- `/bundle` `waitUntil` prewarm in `rss/index.ts`.
- Meta tag paths preserve catalog columns on write.
- **Done.**

## Slice 4 — Background hydrate

- `hydrateArticleMetaFromFeeds`: Workers Cache `/bundle` → RSS fallback.
- `ctx.waitUntil` from `/rec/articles` when `missing` non-empty.
- **Done.**

## Slice 5 — Client Rec diagnostics

- `fetchRecArticles` + `parseRecArticlesResponse`.
- Single-flight lookup; settled-ID refs; coverage line.
- `articleCatalogMissingTitleLabel()` for missing titles.
- **Done.**

## Slice 6 — Safeguards and tests

- Rate limit `/rec/articles`.
- Worker + client unit tests; `make test` runs both packages.
- **Done.**

## Slice 7 — Feed-pool ranking (ricochet upstream + Boomerang wire-up)

- Spec for ricochet library changes: [`ricochet-feed-pool-interface.md`](./ricochet-feed-pool-interface.md)
- **Pending:** ricochet `POST /recommendations/:userId` with `candidateArticleIds`; cold-item scoring for ids without `item_factors`
- **Pending:** Boomerang client sends pool ids after fetch; Rec tab and `rankFeed` use pool-scoped ranks only

## Deploy note

Redeploy **platform-worker** for KV path, hydrate, rate limit, and 6-month TTL. News-feed changes are static assets only. Feed-pool ranking requires a ricochet release + follow-up Boomerang PR.
