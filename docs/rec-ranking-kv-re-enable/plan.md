# Plan: safely re-enabling recommendation KV cache

**Feature slug:** `rec-ranking-kv-re-enable`  
**Scope:** `platform-worker` `/recommendations` — optional read-through / write-back to `REC_STORE` (ranking cache only).

## Why it is off today

- `REC_STORE` is **shared** with other writers (e.g. bundle-time article metadata prewarm). Ranking cache **puts** share the same **daily KV write budget**.
- **Feed-pool** ranking (POST with `candidateArticleIds` or GET with `candidates=`) must **never** use a per-pool KV key at scale — it caused a **write storm** (many unique keys per pool/chunk).
- Code therefore gates ranking KV behind:
  - **`PAUSE_REC_RANK_KV`** in `platform-worker/src/domains/rec/index.ts` — when `true`, **no** `REC_STORE.get` / `put` on the recommendations path.
  - When pause is lifted, **`REC_ENABLE_RANK_KV`** (env) must be truthy **and** the request must be **global** mode only (no explicit candidate list).

Re-enabling is **global-only, low-volume** by design.

## What “global” vs “feed-pool” means here

| Client pattern | `candidateModeProvided` | KV eligible (if unpaused + env on) |
|----------------|-------------------------|--------------------------------------|
| `GET /recommendations/:userId?limit=n` (no `candidates`) | no | yes |
| `POST` body **without** `candidateArticleIds` | no | yes |
| `POST` with `candidateArticleIds` or GET with `candidates=` | yes | **no** (always bypass KV) |

Boomerang’s **news-feed** ranks the feed pool via **POST + chunks** → **feed-pool only** → KV is **not** used for normal app traffic even after re-enable. Caching helps **global** discovery-style calls if you add them later.

## Preconditions (do not skip)

1. **KV quota healthy** — In Cloudflare dashboard, confirm `REC_STORE` namespace is not at daily **write** limits. If limits were exceeded, wait for reset or upgrade plan.
2. **Other writers under control** — Review volume of non-ranking `REC_STORE` usage (e.g. RSS/article paths). Ranking cache adds **at most** one **put** per cache miss per stable key: `recs:{userId}:limit:{limit}`.
3. **Observability** — Platform worker logs / traces for `/recommendations`; optional: alert on `rec_internal_error` or KV-related failures.

## Rollout phases

### Phase 0 — Baseline (current)

- `PAUSE_REC_RANK_KV === true` → zero ranking KV I/O.
- Deploy and confirm no ranking KV errors for several days.

### Phase 1 — Env only (no code change)

Leave **`PAUSE_REC_RANK_KV` true**. Optionally set **`REC_ENABLE_RANK_KV=1`** in Wrangler / dashboard — it has **no effect** until pause is false (documents intent, harmless).

### Phase 2 — Unpause in a branch / preview first

1. Set **`PAUSE_REC_RANK_KV = false`** in `platform-worker/src/domains/rec/index.ts`.
2. Set **`REC_ENABLE_RANK_KV=1`** for the **preview / staging** worker only (separate KV namespace id if possible).
3. Smoke-test:
   - **Feed:** normal usage — expect **`cache.status`: `bypass`**, key contains `ranking:kv-off` or bypass semantics (no pool caching).
   - **Global:** `GET /recommendations/:testUser?limit=50` without candidates — expect possible **`hit`** / **`miss`** / **`bypass`** and non-zero `cacheLookup` / `cacheWrite` in `timingMs` on miss.
4. Monitor KV metrics and error rates for **24–48 hours**.

### Phase 3 — Production

1. Merge after Phase 2 is clean.
2. Set production **`REC_ENABLE_RANK_KV=1`** (Wrangler `vars` or dashboard secret per your policy).
3. Deploy production with **`PAUSE_REC_RANK_KV = false`**.
4. Rollback plan: set **`PAUSE_REC_RANK_KV = true`** and redeploy **immediately** (no need to remove env var first; pause overrides).

## Rollback (fast)

1. Set **`PAUSE_REC_RANK_KV = true`** in `rec/index.ts`.
2. Deploy. Ranking continues to work; only KV read/write on `/recommendations` stops again.

## TTL and keys (reference)

- Global cache key: `recs:{userId}:limit:{limit}` (see `buildRecCacheKey` with no pool).
- TTL constant: `GLOBAL_REC_KV_TTL_SECONDS` (currently 3600s) in `rec/index.ts`.

## Files to touch when re-enabling

| File | Change |
|------|--------|
| `platform-worker/src/domains/rec/index.ts` | `PAUSE_REC_RANK_KV = false` |
| `platform-worker/wrangler.jsonc` (or dashboard) | `REC_ENABLE_RANK_KV=1` |
| `platform-worker/src/env.ts` | Optional type already includes `REC_ENABLE_RANK_KV?` |

## Out of scope

- Caching **feed-pool** responses in KV without a new design (e.g. separate namespace, coarser keys, or DO-local cache) — **not** recommended on free/low KV tiers.
- Moving ranking cache to **Durable Object storage** — valid future work if KV remains contentious.

## Checklist summary

- [ ] KV write quota OK for namespace  
- [ ] Staging: pause off + env on → smoke global GET + normal feed POST  
- [ ] Monitor staging KV + errors  
- [ ] Production: same + rollback path verified  
- [ ] Document any change to `GLOBAL_REC_KV_TTL_SECONDS` if ops changes cadence  

---

*Related: `docs/article-metadata-lookup/ricochet-feed-pool-interface.md` (feed pool ↔ worker); `docs/edge-recommendations/boomerang-context.md` (IDs and rec conventions).*
