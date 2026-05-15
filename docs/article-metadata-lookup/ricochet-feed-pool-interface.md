# Ricochet interface — feed-pool candidate ranking

**Audience:** `@victusfate/ricochet` maintainers and Boomerang integrators.  
**Related Boomerang docs:** [`design.md`](./design.md), [`prd.md`](./prd.md), [`plan.md`](./plan.md).  
**Status:** Proposed — not yet implemented in ricochet or wired end-to-end in Boomerang.

---

## Summary

Boomerang needs ricochet to **score and rank a caller-supplied list of article IDs** (the user’s current feed pool), not to return the globally top items from `item_factors`. The client comment on `RecCoreResponse.articleIds` already says *“client filters against its live article pool”* — we want that filtering to happen **inside** ricochet so rankings, diagnostics, and observability all refer to the same visible set.

---

## Problem with current behavior

Today `RecDO` handles `GET /recs/:userId` like this (simplified):

```ts
const candidates = this.getTopCandidates(200); // global item_factors ORDER BY bias DESC
const scored = this.score(userId, candidates);
const topScored = scored.ranked.slice(0, limit);
```

Effects for Boomerang:

| Issue | Impact |
|--------|--------|
| Candidates are global | IDs often **not** in the user’s current RSS fetch |
| `score()` only returns rows in `item_factors` | Feed articles the user has never interacted with may be **omitted** entirely |
| Rec tab shows worker top-N | Many rows lack local titles; misleading vs feed boost |
| Feed boost uses `rankFeed(pool, prefs, recArticleIds)` | Boost only applies to `pool ∩ recArticleIds`; global IDs outside pool are useless |

Boomerang does **not** need recommendations for articles the user cannot see.

---

## Goal

Given:

- `userId` — anonymous stable user id  
- `candidateArticleIds[]` — deduped 16-hex article ids from the **current feed pool** (typically tens–hundreds of ids)  
- `limit` — max rows to return (Boomerang uses ≤ 50 for observability, up to full pool size for ranking)

Return:

- `articleIds` / `scoredArticleIds` — **only** ids from `candidateArticleIds`, ordered by personalised BiasedMF score (high → low), excluding user downvotes  
- `diagnostics` — `candidateCount` = input size, `rankedCount` = scored rows, etc.  
- Every **input** candidate should appear in output unless downvoted (see cold-item scoring below)

---

## Proposed HTTP API (worker surface)

### Option A — `POST` (preferred for large pools)

```
POST /recommendations/:userId
Content-Type: application/json

{
  "candidateArticleIds": ["4533dca28533f791", "41f5cb60ba5d3d2e", ...],
  "limit": 50
}
```

**Response:** unchanged `RecResponse` / `RecCoreResponse` shape.

### Option B — `GET` query param (small pools / debugging)

```
GET /recommendations/:userId?candidates=id1,id2,id3&limit=50
```

Same response shape. Document URL length limits; Boomerang may send 200–400 ids → prefer POST.

### Backward compatibility

| Request | Behavior |
|---------|----------|
| No `candidateArticleIds` / `candidates` | **Legacy:** `getTopCandidates(200)` then score (current behavior) |
| With candidates | **New:** score supplied ids only (feed-pool mode) |

Document breaking vs non-breaking: existing clients unchanged if they omit candidates.

---

## Proposed Durable Object internal route

Mirror the public contract on the DO stub Boomerang’s platform-worker calls:

```
GET http://do-internal/recs/:userId?limit=50&candidates=id1,id2,...
```

or

```
POST http://do-internal/recs/:userId
{ "candidateArticleIds": [...], "limit": 50 }
```

`platform-worker` forwards client body/params and adds observability (trace, KV cache, timing).

---

## TypeScript contract changes (`types.ts`)

```ts
/** Request body for feed-pool ranking (POST /recommendations/:userId). */
export interface RecRankRequest {
  /** Deduped article ids to score; must be non-empty for pool mode. */
  candidateArticleIds: string[];
  /** Max rows returned; default 50, cap e.g. 500. */
  limit?: number;
}

export interface RecDiagnostics {
  // ... existing fields ...
  /** When set, indicates feed-pool mode vs global candidate mode. */
  candidateMode?: 'feed-pool' | 'global';
}
```

Optional: export a pure function for tests:

```ts
/** Score and rank arbitrary candidates (library consumers, unit tests). */
export function rankCandidates(
  userId: string,
  candidateArticleIds: string[],
  store: RecStore, // abstract interface over SQLite/KV
  params?: MfParams,
): { ranked: ScoredArticle[]; excludedDownvotes: number; coldStart: boolean };
```

---

## Scoring semantics (required behavior change)

### Current `score(userId, candidateIds)`

1. Loads `item_factors` rows `WHERE article_id IN (candidateIds)`  
2. Scores only those rows  
3. **Ids with no `item_factors` row are dropped** (not in `ranked`)

### Required `scoreFeedPool(userId, candidateIds)` (name TBD)

For **each** id in `candidateArticleIds` (after dedupe):

1. If user has **downvoted** id → exclude (unchanged).  
2. If `item_factors` row exists → `score = mfPredict(globalMean, userFactor, itemFactor)`.  
3. If **no** `item_factors` row → **cold item**:  
   - `score = mfPredict(globalMean, userFactor, zeroFactorRow())`  
   - (same cold-start semantics as a new item before first interaction)  
4. Sort all included ids by score descending.  
5. Apply `limit` to returned slice.

**Rationale:** Feed articles appear in the pool before the user (or anyone) has generated an interaction that created `item_factors`. They must still receive a rank and appear in `scoredArticleIds` so Boomerang can apply CF boost and show them in Rec diagnostics.

**Optional later:** On first sight in pool, lazily insert a zero `item_factors` row — not required for v1 if cold scoring is explicit.

---

## Limits and validation

| Field | Suggested cap | Notes |
|--------|----------------|-------|
| `candidateArticleIds.length` | 500 | Boomerang feed pool size; reject 400 with clear error |
| `limit` | 500 | Default 50 |
| Id format | non-empty string | 16-hex in Boomerang; ricochet can stay format-agnostic |

Validation errors: `400` with `{ ok: false, message: "..." }` consistent with `/interactions`.

---

## Caching (worker / platform integrators)

Boomerang **platform-worker** caches `RecCoreResponse` in `REC_STORE` under keys like `recs:${userId}`.

**Feed-pool mode must not share cache with global mode.**

Suggested cache key:

```
recs:${userId}:pool:${hash(sorted(candidateArticleIds))}
```

- Hash: SHA-256 of sorted comma-joined ids (hex prefix), or stable FNV.  
- TTL: short (e.g. 300s) — pool changes every feed refresh.  
- When `candidateArticleIds` changes, cache miss → fresh rank.

Document in ricochet README that **callers** own cache key design when using pool mode.

---

## Diagnostics fields (observability)

When `candidateMode === 'feed-pool'`:

| Field | Meaning |
|--------|---------|
| `candidateCount` | `candidateArticleIds.length` after dedupe |
| `rankedCount` | Scored rows before `limit` slice |
| `returnedCount` | `articleIds.length` after `limit` |
| `excludedDownvotes` | Input ids removed due to downvote |
| `coldStart` | User has no `user_factors` row (unchanged) |

Optional new fields (nice-to-have):

| Field | Meaning |
|--------|---------|
| `coldItemCount` | Candidates scored with zero item factors |
| `warmItemCount` | Candidates with existing `item_factors` |

---

## Boomerang consumer contract (after ricochet ships)

1. **When:** After `articlePool` has articles (post–fast-tier or full fetch).  
2. **Call:** `POST /recommendations/:userId` with `candidateArticleIds = articlePool.map(a => a.id)`.  
3. **Use:** `articleIds` / `scoredArticleIds` for `rankFeed` boost and Rec tab (all ids ⊆ pool → titles from local map).  
4. **Re-fetch:** When pool changes materially (new fetch / refresh), not on a fixed 5‑minute timer with stale global ids.  
5. **Stop:** Initial mount fetch with no candidates (global top-200).

No change to `POST /interactions` or learning path.

---

## Acceptance criteria (ricochet tests)

1. **Pool mode:** Given candidates `['a','b','c']` where only `'a'` has `item_factors`, response includes all three (unless downvoted), sorted by score.  
2. **Downvote:** Downvoted id absent from `articleIds` but counted in `excludedDownvotes`.  
3. **Limit:** `limit=2` returns top 2 by score only.  
4. **Dedupe:** Duplicate ids in input are deduped once.  
5. **Empty candidates:** `400` or empty ranked list (pick one; document).  
6. **Legacy mode:** Omitting candidates still uses `getTopCandidates(200)`.  
7. **Order:** `articleIds[i]` matches `scoredArticleIds[i].articleId` and is score-sorted.  
8. **Cold user:** `coldStart: true` still ranks pool with global-mean + cold item scores.

---

## Suggested implementation checklist (ricochet repo)

- [ ] Add `parseCandidateIds()` helper (dedupe, cap, trim)  
- [ ] Extend `RecDO.fetch` `/recs/:userId` for `candidates` query + optional POST body  
- [ ] Implement `scoreAllCandidates()` (or extend `score()`) with cold-item branch  
- [ ] Update `types.ts` + README + worker `GET /recommendations` handler  
- [ ] Vitest: pool-only candidates, cold items, downvotes, limit, legacy global path  
- [ ] Semver: **minor** bump (additive API); note cache-key guidance for integrators  

---

## Suggested Boomerang follow-up (after ricochet release)

- [ ] Bump `@victusfate/ricochet` dependency  
- [ ] `fetchRecommendations(base, userId, { candidateArticleIds, limit })` in `recWorker.ts`  
- [ ] `useRecWorker(articlePoolIds)` — fetch when pool non-empty; debounce on pool change  
- [ ] `useFeed` — re-apply `rankFeed` when pool-scoped `recArticleIds` updates  
- [ ] Platform-worker: POST forward + pool-scoped KV cache key  
- [ ] Rec diagnostics: optional note “ranked within current feed (N articles)”  

---

## Reference: current ricochet surfaces

| Layer | File / route | Notes |
|--------|----------------|-------|
| DO | `src/RecDO.ts` | `getTopCandidates`, `score`, `/recs/:userId` |
| Worker | `src/index.ts` | `GET /recommendations/:userId`, KV cache |
| Types | `src/types.ts` | `RecCoreResponse`, `ScoredArticle`, `RecDiagnostics` |
| Library | `src/lib.ts` | `mfPredict`, `zeroFactorRow`, `DEFAULT_MF_PARAMS` |

Boomerang embeds ricochet via `platform-worker` (`RecDO` export from `@victusfate/ricochet/worker`) and does not fork scoring logic today.

---

## Open questions for ricochet

1. **Empty pool:** Return `200` with empty lists vs `400`? (Boomerang prefers `200` empty.)  
2. **Max candidates:** 500 enough for integrators with large OPML imports?  
3. **Export `rankCandidates` on lib entry** for offline eval / tests?  
4. **Item factor lazy init** on pool sight — in scope or defer?

---

## Version targeting

Proposed ricochet release: **v1.2.0** (minor, additive).  
Boomerang will pin `github:victusfate/ricochet#<tag>` after publish.
