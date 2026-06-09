# Ricochet Changes — Article Search History Backfill

## Context

The `article-search` feature in `victusfate/boomerang` needs to backfill a local
interaction history store from existing `readIds` (up to 1,000 IDs) and
`unsavedAtById` keys (unbounded) stored in user prefs. Full article metadata
(title, url, source, publishedAt) is available in the `ARTICLE_META` KV via the
existing `GET /rec/articles?ids=...` endpoint.

## Current limitation

`GET /rec/articles?ids=a,b,c,...` is capped at **50 IDs per request**
(`MAX_ARTICLE_IDS_LOOKUP = 50` in `articleMetaContract.ts`). Backfilling 1,000
`readIds` requires ~20 sequential-or-parallel batched GET requests. This works
but has two drawbacks:

1. URL length grows with ID count — each 16-hex ID adds ~17 chars; 50 IDs ≈ 850
   chars of query string, well within limits but inelegant.
2. Parallel fan-out of 20 requests hits the KV read quota harder than a single
   batched request.

## Requested change

Add a **POST variant** of the article metadata lookup endpoint:

```
POST /rec/articles
Content-Type: application/json

{ "ids": ["a3f1c2d4b5e60718", "..."] }   // up to 500 IDs
```

Response shape: identical to the existing `RecArticlesResponse`:

```ts
interface RecArticlesResponse {
  ok: true;
  requested: number;
  found: number;
  missing: string[];
  articles: RecArticleMeta[];   // { id, title, url, source, sourceId, publishedAt }
  timingMs?: { kvLookup: number; hydrate: number; total: number };
}
```

### Why 500?

- `readIds` cap is 1,000 in UserPrefs — two requests max for a full backfill.
- `unsavedAtById` is unbounded but practically small (dequeue events only).
- 500 parallel KV reads is well within Cloudflare Worker limits.

### ID validation

Same as current: filter non-hex / wrong-length IDs, deduplicate, enforce the
new cap (return 400 if `ids.length > 500`).

## Priority

**Optional / nice-to-have.** The boomerang client can work around the 50-ID
limit by batching GET requests in groups of 50. The POST endpoint makes the
backfill a single request and is the right long-term API shape, but it is not
blocking the feature.

## No other changes needed

- The `ARTICLE_META` KV TTL (180 days) is already sufficient for search history.
- `lookupArticleMetaByIds` in `articleMetaKv.ts` already handles parallel KV
  reads correctly — the POST handler can reuse it directly with a higher input
  cap.
- CORS: the platform-worker owns CORS for all `/rec/*` routes; no changes needed
  there.

## Files to touch in `platform-worker`

| File | Change |
|---|---|
| `src/domains/rec/articleMetaContract.ts` | Add `MAX_ARTICLE_IDS_LOOKUP_POST = 500`; export it |
| `src/domains/rec/index.ts` (or equivalent route handler) | Add `POST /rec/articles` handler — parse body, validate IDs, call `lookupArticleMetaByIds` |
| `src/domains/rec/articleMeta.node.test.ts` | Test the new POST handler: valid batch, oversized batch (400), empty body (400) |
