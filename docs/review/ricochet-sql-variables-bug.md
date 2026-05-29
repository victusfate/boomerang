# Upstream bug report — ricochet `scoreCandidates` exceeds workerd's 100 SQL-variable limit

**Package:** `@victusfate/ricochet` (observed at **v1.4.2**, `github:victusfate/ricochet`)
**Runtime:** Cloudflare `workerd` (reproduced locally on `1.20260526.1` via `wrangler dev`)
**Severity:** Global recommendations endpoint returns HTTP 500 once `item_factors` grows past 100 rows.

---

## Summary

`RecDO.scoreCandidates()` builds a single `... WHERE article_id IN (?,?,…)` query and binds
**every** candidate id as its own SQL parameter. workerd's Durable Object SQLite caps bound
parameters at **100** (`SQLITE_MAX_VARIABLE_NUMBER = 100`). The **global** candidate path
generates up to `GLOBAL_CANDIDATE_LIMIT = 200` candidates, so as soon as the store holds
more than 100 `item_factors` rows the query throws:

```
Uncaught Error: too many SQL variables at offset 318: SQLITE_ERROR
    at scoreCandidates (.../@victusfate/ricochet/src/RecDO.ts:435:36)
    at fetch        (.../@victusfate/ricochet/src/RecDO.ts:169:27)
```

The **feed-pool** path is unaffected only by coincidence: it is validated against
`REC_MAX_CANDIDATES = 100`, which exactly matches the limit, so callers that chunk to ≤100
never trip it.

---

## Offending code

`src/RecDO.ts` — `scoreCandidates()`:

```ts
const itemRows = candidateIds.length === 0
  ? []
  : [...this.state.storage.sql.exec<ItemRow>(
      `SELECT article_id,bias,v0,v1,v2,v3,v4,v5,v6,v7,v8,v9,topic,all_topics
       FROM item_factors WHERE article_id IN (${candidateIds.map(() => '?').join(',')})`,
      ...candidateIds,                       // ← one bound variable per candidate
    )];
```

Caller (`fetch` → global branch):

```ts
candidates = isColdStart
  ? this.getDiverseCandidates(GLOBAL_CANDIDATE_LIMIT)   // up to 200
  : this.getTopCandidates(GLOBAL_CANDIDATE_LIMIT);      // up to 200
const scored = this.scoreCandidates(userId, candidates, topicWeights);
```

`getTopCandidates` / `getDiverseCandidates` are themselves bounded only by `LIMIT 200` and the
row count of `item_factors`, so any store with >100 item factors breaks the global path.

---

## Why "offset 318" pinpoints the 100-variable limit

The error's `offset` is the character position of the parameter that overflows:

- SQL prefix up to the first `?` (`SELECT … IN (`) is ~118 chars.
- Each subsequent placeholder `?,` is 2 chars.
- `(318 − 118) / 2 ≈ 100` → the **101st** placeholder is the first one rejected.

So the effective cap is **100 bound variables**, matching `REC_MAX_CANDIDATES`.

---

## Reproduction

1. Seed a RecDO with >100 distinct `item_factors` rows (e.g. ingest interactions for 132 articles).
2. `GET /recommendations/:userId` (global mode — no `candidates`, no POST body).
3. Observe HTTP 500 with the stack trace above.

Confirmed locally:

```
GET  /recommendations/<user>           → 500  too many SQL variables (132 item_factors)
POST /recommendations/<user> (100 ids) → 200  OK
GET  /rec/debug                        → itemFactorsCount: 132
```

---

## Proposed fix (upstream)

Chunk the `IN (...)` lookup so no single statement binds more than the limit, then merge results.
This keeps `scoreCandidates` correct for any candidate-set size and removes the hidden coupling to
`REC_MAX_CANDIDATES`.

```ts
const SQL_VAR_LIMIT = 100; // workerd Durable Object SQLite bound-parameter cap

const itemRows: ItemRow[] = [];
for (let i = 0; i < candidateIds.length; i += SQL_VAR_LIMIT) {
  const chunk = candidateIds.slice(i, i + SQL_VAR_LIMIT);
  itemRows.push(...this.state.storage.sql.exec<ItemRow>(
    `SELECT article_id,bias,v0,v1,v2,v3,v4,v5,v6,v7,v8,v9,topic,all_topics
     FROM item_factors WHERE article_id IN (${chunk.map(() => '?').join(',')})`,
    ...chunk,
  ));
}
```

Alternatives considered:

- **Cap `GLOBAL_CANDIDATE_LIMIT` at 100.** Smallest change, but silently shrinks the global
  candidate pool and leaves the latent crash for any future caller that passes >100 ids.
- **Temp table + join** (insert candidates, `JOIN`). Avoids the variable limit entirely but is
  heavier than chunking for the candidate-set sizes in play.

Chunking is preferred: it fixes the root cause with no behavioral regression.

---

## Impact on Boomerang

- **UI: not affected.** `news-feed` only calls the feed-pool **POST** path
  (`fetchFeedPoolRecommendations` → chunked to `REC_MAX_CANDIDATES`), which stays at/under 100.
- **Affected:** `GET /recommendations/:userId` (global) and anything that relies on it
  (e.g. ad-hoc diagnostics / direct API calls) returns 500 once the store exceeds 100 item factors.

## Interim mitigation (until upstream ships)

Boomerang's `platform-worker/src/domains/rec/RecDO.ts` already wraps the base class. If a fix is
needed before an upstream release, the global path can be guarded there (cap forwarded `limit` /
candidate generation to ≤100, or override `scoreCandidates`). Not required for current UI behavior.
