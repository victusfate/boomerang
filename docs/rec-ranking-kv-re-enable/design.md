# KV Budget Review — Recommendation Ranking Re-enable

**Feature slug:** `rec-ranking-kv-re-enable`  
**Date:** 2026-05-16  
**Scope:** Full audit of KV read/write sources across `platform-worker`; architecture options for re-enabling ranking cache without quota risk.

---

## 1. Cloudflare KV quota reality

**Free tier:** 100 k reads / day · 1 k writes / day — **account-wide, not per namespace.**  
Separate KV namespaces (`ARTICLE_META` vs `REC_STORE`) share the same 1 k write budget. A "separate namespace" does not give you a separate quota; it only gives isolation for management purposes.

---

## 2. Current KV consumers after the pause

### 2a. `ARTICLE_META` namespace

| Operation | Trigger | Frequency estimate |
|---|---|---|
| `.get(articleRecordKey(id))` | `loadCachedArticleMeta` on every cache miss | Low if mem cache warm; potentially high on cold isolate |
| `.get(articleRecordKey(id))` (read-before-write) | `persistArticleMeta` for new/changed articles | Once per new article per isolate lifetime |
| `.put(articleRecordKey(id))` | `persistArticleMeta` when article is new or fields changed | **Key write consumer** |

The mem cache guard (500 entries, 1h TTL) is effective for hot articles. However, every new isolate starts cold. With ~50–100 articles per bundle cycle, a cold isolate can trigger ~50–100 `.get` calls, plus some `.put` calls for articles the isolate hasn't seen.

### 2b. `REC_STORE` namespace

| Operation | Trigger | Status |
|---|---|---|
| `.get(articleMetaCacheKey(id))` | `loadCachedArticleMeta` legacy fallback when `ARTICLE_META` misses | **Active — should be removed** |
| `.get(cacheKey)` for ranking | `handleRec` global recommendations | Disabled (`PAUSE_REC_RANK_KV = true`) |
| `.put(cacheKey)` for ranking | `handleRec` global recommendations | Disabled |

### 2c. Dead code introduced by the pause

`buildRecCacheKey` with a `candidateArticleIds` argument and `hashCandidateArticleIds` are now unreachable:

- `useKvCache` is `false` whenever `candidateModeProvided` is `true`
- When `useKvCache` is `true`, `buildRecCacheKey` is called with `undefined` (global mode)

These functions can be removed or kept for when KV is re-enabled — but the pool-hash path should **never** be re-introduced (it was the write storm source).

---

## 3. Remaining risks in the current code

### Risk A — Legacy `REC_STORE` fallback reads

`loadCachedArticleMeta` falls through to `REC_STORE.get(articleMetaCacheKey(id))` when `ARTICLE_META` misses. These reads:
- Burn shared read quota
- Represent the old key schema (`article-meta:<id>`) that predates `ARTICLE_META`
- Will naturally stop hitting once `ARTICLE_META` is fully populated, but there is no explicit cutover date

**Fix:** Add a compile-time flag (or env var) to disable the legacy fallback once migration is confirmed complete.

### Risk B — Parallel KV reads on cold isolate

`loadCachedArticleMeta` fans out `Promise.all(ids.map(...))`. On a cold isolate with 400 feed-pool article IDs, this fires 400 `.get` calls in parallel. At 100 k reads/day budget, 400 reads per request × dozens of requests = quota risk.

The mem cache mitigates this quickly (after the first `/rec/articles` call, most are in mem), but the initial load window is exposed.

**Fix (short-term):** The mem cache already handles this; verify the cache is warm before the first ranking call. Consider a pre-warm step in `scheduledRec`.

**Fix (long-term):** See architecture options below.

### Risk C — `persistArticleMeta` KV read-before-write

Every call to `persistArticleMeta` issues a `.get` to check whether the article already exists in `ARTICLE_META` (to avoid unnecessary writes). This read is skipped only if the mem cache has a match with identical fields. On a cold isolate that just ingested new articles, this is 1 read + 1 write per new article.

**Estimate:** 50 new articles/day × 1 read + 1 write = 50 reads + 50 writes. Acceptable on its own. Becomes a concern if many isolates start cold simultaneously.

---

## 4. Architecture options for ranking cache re-enable

### Option A — DO-local SQLite cache (recommended)

Add a `ranking_cache` table to `RecDO`'s SQLite database:

```sql
CREATE TABLE IF NOT EXISTS ranking_cache (
  cache_key   TEXT PRIMARY KEY,
  payload     TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);
```

- **Feed-pool POST:** hash `(userId, sorted candidateIds)` → check `ranking_cache`; on miss, run `score()` and write back. TTL: 5 min.
- **Global GET:** key `(userId, limit)` → check `ranking_cache`; on miss, run `getTopCandidates + score()` and write back. TTL: 1 h.
- Eviction: `DELETE FROM ranking_cache WHERE expires_at < unixepoch() * 1000` in the existing hourly `/prune` handler.

**Pros:**
- Zero KV operations for rankings
- SQLite in-process — sub-millisecond reads
- No external quota at all (DO storage is separate from KV quota)
- Handles both feed-pool and global mode correctly

**Cons:**
- Single global DO instance means cache is shared across all users (fine — already the case)
- DO SQLite write throughput is bounded (not a concern at current scale)
- Cache is per-DO-instance only; a new DO instance starts cold (extremely rare for `idFromName('global')`)

### Option B — CF Cache API for global GET (complementary to A)

Set `Cache-Control: private, max-age=3600` on `GET /recommendations/:userId?limit=n` responses (no `candidates` param). The Cloudflare edge caches per (URL + Vary header). Feed-pool POSTs are inherently not cacheable at the edge.

**Pros:** Zero KV, zero DO storage, pure edge cache  
**Cons:** Only works for GET/global mode; requires clients to use GET not POST for global calls; `private` cache means user-specific URLs are cached per data center, not globally

This is best used as a **complement** to Option A, not a replacement.

### Option C — Dedicated `REC_RANKINGS` KV namespace

Create a third KV namespace (`REC_RANKINGS`) exclusively for ranking cache, with the understanding that it still shares the account write budget.

**Why this is not sufficient:** The free-tier write quota is account-wide. Splitting into a new namespace does not add quota; it only enables separate monitoring. The write storm problem would recur.

### Option D — Remove `ARTICLE_META` KV, move metadata to DO SQLite

Store article metadata (title, url, source, publishedAt) in RecDO's (or MetaDO's) SQLite alongside `item_factors`. Since `item_factors` already has `article_id`, adding a few columns or a join table is feasible.

**Pros:** Eliminates the `ARTICLE_META` KV namespace entirely; article metadata lookup becomes a DO SQLite query (fast, free)  
**Cons:** Requires changes to both the DO schema and the `/rec/articles` path; MetaDO is a better home since it already handles article-level metadata tags; adds coupling between rec and meta domains

This is **future work** worth designing separately.

---

## 5. Recommended re-enable path

Given the above, the lowest-risk route to re-enabling recommendations with caching:

1. **Keep `PAUSE_REC_RANK_KV = true` for article ranking.** Global KV ranking cache adds marginal value since feed-pool mode is what the app actually uses, and feed-pool scores change with each pool refresh anyway.

2. **Add DO-local `ranking_cache` table (Option A)** — this is the primary win:
   - Feed-pool requests get fast repeat responses (same pool, same user, within 5 min) without any KV I/O
   - Replace the KV-based ranking cache entirely

3. **Remove the legacy `REC_STORE` fallback read** in `loadCachedArticleMeta` — set a sunset date after verifying `ARTICLE_META` coverage.

4. **Clean up dead code:**
   - Remove `hashCandidateArticleIds` and the pool-hash path from `buildRecCacheKey` (never re-introduce per-pool KV keys)
   - Remove `GLOBAL_REC_KV_TTL_SECONDS` if Option A is adopted (DO cache replaces it)

5. **Monitor `ARTICLE_META` write volume** via the existing `/rec/debug` KV counters. If writes consistently stay below ~200/day, there is headroom to re-enable global KV ranking cache as a backup layer.

---

## 6. Quick wins (no architecture change needed)

| Change | File | Impact |
|---|---|---|
| Remove legacy `REC_STORE` fallback read | `articleMetaKv.ts` | −N reads/day |
| Add `ranking_cache` table to RecDO | `RecDO` (ricochet or platform-worker) | All ranking responses cached in DO SQLite |
| Pre-warm article meta on `scheduledRec` | `rec/index.ts` | Cold isolate first-request read spike eliminated |
| Delete `hashCandidateArticleIds` + pool-key path | `rec/index.ts` | Dead code removal, prevents future misuse |

---

## 7. Canonical vocabulary (additions)

| Term | Meaning |
|---|---|
| **global mode** | Recommendations without a candidate list; DO picks top candidates itself (`getTopCandidates`) |
| **feed-pool mode** | Recommendations with explicit `candidateArticleIds`; DO scores only those articles |
| **ranking cache** | Stored result of a completed MF scoring pass; avoids re-scoring the same (user, pool) pair |
| **DO-local cache** | Ranking cache stored in the RecDO's SQLite storage — zero KV quota consumption |
| **KV write storm** | The previous bug: unique per-pool-hash KV keys causing hundreds of `.put` per day |

---

*See `plan.md` in this folder for the phased rollout checklist once Option A (DO-local cache) is implemented.*
