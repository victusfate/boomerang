# Ricochet upstream feedback — Boomerang integration review
_May 2026_

---

## Bugs / API gaps

### 1. ~~`parseTopicWeights` not exported from public lib~~ ✅ Fixed in v1.6.1

`parseTopicWeights` is now exported from `dist/lib.d.ts`. Boomerang's hand-rolled copy removed; importing directly from `@victusfate/ricochet`.

---

### 2. TypeDoc not regenerated for v1.6.0

`docs/api/README.md` and `docs/api/globals.md` both read "Ricochet v1.5.0". The `RecRankRequest` interface page shows only `candidateArticleIds` and `limit` — `topicWeights` (added in v1.6.0) is absent entirely. A consumer reading the published API docs has no indication the field exists.

**Suggested fix:** re-run TypeDoc as part of the v1.6.0 release and commit the updated `docs/api/` output.

---

## Fixed — no action needed

### SQL variables crash in `scoreCandidates` (reported at v1.4.2)

The single `WHERE article_id IN (?,?,…)` query bound every candidate as its own SQL parameter. workerd Durable Object SQLite caps bound parameters at 100 (`SQLITE_MAX_VARIABLE_NUMBER`), so the global path (up to 200 candidates) threw `SQLITE_ERROR: too many SQL variables` once `item_factors` exceeded 100 rows.

**Status: fixed in v1.6.0** — `scoreCandidates` now chunks the `IN (…)` lookup at 100 rows per statement and merges results.

---

## Open feature requests

### 3. Cold-start popularity blend (Gap 1)

`candidateStrategy: 'diverse'` (v1.5.0) improves cold-start by using topic-bucketed candidates instead of pure top-by-bias, which breaks the popularity feedback loop. The original request was a configurable blend between latent-factor score and a pre-computed popularity signal during the cold-start window:

```ts
// proposed config
{
  coldStartBlend: 0.6,       // weight of popularity bias when interactions < threshold
  coldStartThreshold: 30,    // interactions needed to fully trust latent factors
}
```

This would let freshly onboarded users see genuinely popular articles rather than the near-random ranking that results from untrained zero-vectors.

---

### 4. "Never show" negative class signal (Gap 4)

Users can downvote individual articles but have no way to express "never show sports" at the model level. Topic-disable toggles in Boomerang filter articles out client-side but never feed back into the model, so the BiasedMF scores remain unaffected.

**Proposed addition:** accept `dislikedTopics: Topic[]` or `dislikedSources: string[]` in the interaction payload or as a separate preference update. The model would apply a persistent negative bias to items matching those classes.

---

### 5. ETag / invalidation signal on `/recommendations` (Gap 5)

Clients currently poll `/recommendations` on a fixed interval (5 min) with no way to detect whether the model has actually changed. A monotonic version token or content hash in the response would let clients skip the re-rank when nothing has changed since the last fetch.

**Proposed addition:** return a `modelVersion` or `etag` header alongside `RecResponse`. Clients send `If-None-Match`; server returns `304 Not Modified` when the user's factors haven't updated since `generatedAt`.
