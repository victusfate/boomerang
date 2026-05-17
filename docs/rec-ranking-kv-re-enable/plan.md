# Plan: DO-local ranking cache (replaces KV ranking cache)

**Feature slug:** `rec-ranking-kv-re-enable`  
**Updated:** 2026-05-17  
**Scope:** `platform-worker` `/recommendations` — ranking results cached in `RecDO` SQLite storage, replacing the former KV-based ranking cache.

---

## Why KV ranking cache was removed

- Cloudflare KV quota is **account-wide** (free tier: 1 k writes/day, 100 k reads/day); both `ARTICLE_META` and `REC_STORE` share this limit.
- **Feed-pool** ranking (POST with `candidateArticleIds`) used per-pool SHA-256 hash keys — every unique candidate set created a new `.put`, causing a **write storm** that hit the daily limit.
- Code response: hard-coded `PAUSE_REC_RANK_KV = true` in `rec/index.ts` — zero KV I/O on `/recommendations` until a safer architecture was ready.

---

## Implemented: DO-local SQLite ranking cache

### Architecture

`platform-worker/src/domains/rec/RecDO.ts` extends the ricochet `RecDO` base class with a `ranking_cache` table in the DO's own SQLite storage:

```sql
CREATE TABLE IF NOT EXISTS ranking_cache (
  cache_key  TEXT    PRIMARY KEY,
  payload    TEXT    NOT NULL,
  expires_at INTEGER NOT NULL
)
```

The subclass overrides `fetch()` to intercept `GET/POST /recs/:userId` requests:
1. Compute a deterministic cache key.
2. On **cache hit** (key exists and not expired): return stored JSON directly.
3. On **cache miss**: call `super.fetch(request)`, store the response payload, return it.

Cache eviction runs in the `/prune` handler (already called hourly by the cron) via `DELETE FROM ranking_cache WHERE expires_at <= ?`.

### Cache key and TTL

| Mode | Key format | TTL |
|------|------------|-----|
| **Feed-pool** (POST with candidates / GET with `candidates=`) | `recs:{userId}:pool:{sha256_12hex}:{limit}` | **5 min** |
| **Global** (GET or POST without candidates) | `recs:{userId}:global:{limit}` | **1 hour** |

The SHA-256 pool hash uses the **sorted** candidate IDs so that reordering the same pool hits the cache.

### Files changed

| File | Change |
|------|--------|
| `platform-worker/src/domains/rec/RecDO.ts` | **New** — extended `RecDO` with `ranking_cache` table and cache-through logic |
| `platform-worker/src/domains/rec/index.ts` | Export `RecDO` from `./RecDO` instead of `@victusfate/ricochet/worker` |

### Properties

- **Zero KV quota consumption** for ranking — DO storage has no shared daily write limit.
- **Sub-millisecond reads** — SQLite is in-process in the DO.
- **Single global DO** — all users share the same DO instance (`idFromName('global')`), so cache entries are shared across the worker's lifetime.
- **Debug endpoint**: `GET http://do-internal/debug/rank-cache-count` returns `{ activeCacheEntries: N }`.

---

## Current state of KV ranking code in `rec/index.ts`

`PAUSE_REC_RANK_KV = true` remains in `rec/index.ts`. With the DO-local cache implemented, global KV ranking cache is no longer the goal — it can be left paused permanently.

Dead code that can be removed in a future cleanup PR:
- `hashCandidateArticleIds` function
- `buildRecCacheKey` (pool-hash branch)
- `GLOBAL_REC_KV_TTL_SECONDS` constant
- `PAUSE_REC_RANK_KV` flag and related `useKvCache` logic

---

## Global vs feed-pool mode (reference)

| Client pattern | `candidateModeProvided` | DO cache TTL |
|----------------|-------------------------|--------------|
| `GET /recommendations/:userId?limit=n` (no `candidates`) | no | 1 hour |
| `POST` body **without** `candidateArticleIds` | no | 1 hour |
| `POST` with `candidateArticleIds` or GET with `candidates=` | yes | 5 min |

Boomerang's **news-feed** ranks the feed pool via **POST + chunks** → always feed-pool mode → 5-min DO cache.

---

## Remaining follow-up work (out of scope for this branch)

| Item | Priority | Notes |
|------|----------|-------|
| Remove legacy `REC_STORE` fallback read in `articleMetaKv.ts` | Medium | Unnecessary read quota; safe to remove after `ARTICLE_META` migration confirmed |
| Delete `PAUSE_REC_RANK_KV` + dead pool-hash code from `rec/index.ts` | Low | Cosmetic; pause is harmless now that DO cache exists |
| CF Cache API layer for `GET /recommendations/:userId` (global mode only) | Low | Complementary edge cache, free; only helps GET callers |
| Move article metadata to DO SQLite (eliminates `ARTICLE_META` KV entirely) | Future | See `design.md` Option D |

---

*See `design.md` in this folder for the full KV budget audit and architecture options.*
