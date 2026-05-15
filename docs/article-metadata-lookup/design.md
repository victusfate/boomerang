# Design — Article metadata lookup (Rec catalog)

## Q&A summary

**Q1: What problem are we solving?**  
The Rec diagnostics tab shows collaborative-filter article IDs without human-readable titles. The feed’s local article pool only covers recently fetched items; CF recommendations can reference older IDs. We need a **fast, bounded batch lookup by article ID** without misusing `/bundle?include=` (source IDs, not article IDs).

**Q2: Where should catalog data live?**  
In the existing **`ARTICLE_META` KV namespace** (`meta:<articleId>`), not a separate short-lived `REC_STORE` catalog. Tags and catalog fields share one record so TTL and pruning stay unified. `REC_STORE` remains for recommendation list caches (`recs:<userId>`) and legacy `rec:article-meta:*` keys (read fallback only).

**Q3: How long do we retain catalog fields?**  
**Six months** (`ARTICLE_RECORD_TTL_SECONDS` = 180 days in `shared/articleRecordCatalog.ts`). Each KV `put` sets `expirationTtl` from that constant. Tag-only rows gain catalog fields on the next `/bundle` prewarm or hydrate without losing tags.

**Q4: Sync or async hydration on cache miss?**  
**Async.** `/rec/articles` answers from KV only (milliseconds). Misses trigger **`ctx.waitUntil`** background hydrate: try **Workers Cache** for the default `GET /bundle` response, then RSS `fetchFeedsStaggered` only for still-missing IDs. Never block the HTTP response on a full feed fetch (that caused ~7s responses and cost loops).

**Q5: How do we stop the Rec tab from spamming the worker?**  
Client **single-flight** batching: stable `previewKey` (top 12 CF IDs), `inFlightLookupKeyRef`, and `settledLookupIdsRef`. Do not cancel in-flight lookups in a way that skips marking IDs settled (that caused infinite retries). Rate-limit `/rec/articles` at 30 req/min/IP in the rec domain.

**Q6: What IDs are we looking up?**  
16-hex article IDs: `SHA-256(normalized article URL)[:8]`, same as RSS parse and ricochet interactions. Hydration only finds articles still present in fetched feeds; IDs outside the RSS window stay in `missing` until prewarmed by a prior bundle or expire from KV.

**Q7: What does the Rec UI show when title is unknown?**  
`(article metadata outside of cache 6 months)` — copy derived from `articleCatalogMissingTitleLabel()` so it tracks `ARTICLE_RECORD_TTL_SECONDS` if we change retention.

## Decisions

| Topic | Decision |
|--------|----------|
| Primary KV key | `meta:<articleId>` in `ARTICLE_META` |
| Record shape | `articleId`, `tags`, `updatedAt`, optional `title`, `source`, `sourceId`, `publishedAt`, `url` |
| Canonical TTL | `ARTICLE_RECORD_TTL_SECONDS` in `shared/articleRecordCatalog.ts` (worker + UI) |
| Lookup endpoint | `GET /rec/articles?ids=id1,id2,...` (max 50, deduped, request order preserved) |
| Response fields | `requested`, `found`, `missing`, `articles`, `timingMs` (`kvLookup`, `hydrate`, `total`) |
| Prewarm | `/bundle` → `persistArticleMeta` via `ctx.waitUntil` |
| Legacy | Read `rec:article-meta:<id>` from `REC_STORE` if `meta:<id>` has no catalog fields |

## Edge-case scenarios

1. **Cold CF list, warm feed** — User opens Rec before `/bundle`; KV may be empty; fast `/rec/articles` returns `missing`; background hydrate + next bundle fill titles on a later visit.
2. **Tag update without catalog** — Meta WebSocket/HTTP tag write must **preserve** existing `title`/`url` fields on the record.
3. **Stale legacy 24h keys** — `REC_STORE` fallback may still serve titles briefly; new writes go only to `ARTICLE_META`.
4. **Rate limit / error** — Client marks batch settled on failure to avoid retry storms.
5. **TTL change** — Lowering `ARTICLE_RECORD_TTL_SECONDS` only affects **new** puts; existing keys expire on their original schedule.

## Canonical vocabulary

| Term | Meaning |
|------|---------|
| **Article catalog** | Per-article display metadata: `title`, `source`, `sourceId`, `publishedAt`, `url` |
| **Article record** | Full KV value at `meta:<articleId>`: tags + optional catalog fields |
| **Catalog cache** | `ARTICLE_META` KV retention window (`ARTICLE_RECORD_TTL_SECONDS`) |
| **Coverage** | `/rec/articles` fields `found` / `missing` vs `requested` |
| **Prewarm** | Writing catalog into KV from `/bundle` without a dedicated client call |
| **Hydrate** | Background fill of missing IDs from bundle cache and/or RSS |
| **Preview IDs** | Top 12 CF-ranked article IDs shown in Rec diagnostics |

## Relationship to other features

- **`docs/shared-article-metadata`** — Original meta-worker design for **tags** and WebSocket; this feature **extends** the same KV record with catalog fields on `platform-worker`.
- **`docs/edge-recommendations`** — CF model and `/recommendations`; this feature does not change scoring, only title resolution for observability UI.
