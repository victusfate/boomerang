# Suggested follow-up changes — rec ranking cache

**Date:** 2026-05-17  
**Context:** After implementing `claude/do-ranking-cache` (DO-local SQLite ranking cache).  
This document collects every suggested improvement from the design review, risk audit, and ricochet compatibility analysis — prioritised and ready to hand off.

---

## 1. Platform-worker dead code cleanup

**Branch target:** new branch from main  
**Effort:** small (~30 lines deleted)  
**Risk:** zero — all paths being deleted are already disabled

The `PAUSE_REC_RANK_KV = true` flag was a temporary hold. With the DO-local cache in place the KV ranking path is permanently obsolete. Clean it up before anyone re-enables it by mistake.

### 1a. `platform-worker/src/domains/rec/index.ts`

Remove the following dead symbols (unreachable with `PAUSE_REC_RANK_KV = true`):

| Symbol | Line range (approx) | Why removable |
|--------|---------------------|---------------|
| `PAUSE_REC_RANK_KV` constant | ~34 | DO cache replaces KV; flag no longer meaningful |
| `GLOBAL_REC_KV_TTL_SECONDS` constant | ~29 | Only used for KV `.put` expirationTtl |
| `CACHE_TTL_SECONDS` constant | ~27 | Was a bypass-observability hint only |
| `hashCandidateArticleIds` function | ~81–87 | Only fed the pool-hash KV key (the write-storm source) |
| `buildRecCacheKey` function | ~89–97 | Entire function obsolete; DO cache uses its own key scheme |
| `useKvCache` logic + KV `.get` / `.put` blocks | ~337–435 | All wrapped in `if (useKvCache)` which is always false |
| `isRankKvEnabled` function | ~150–153 | Only checked inside the dead `useKvCache` block |
| `cacheKey` variable (KV version) | ~339–341 | Replaced by DO cache key in `RecDO.ts` |
| `cachedRaw` variable and normalization | ~344–373 | KV read path, always bypassed |

After removal, the `handleRec` recommendations branch becomes: parse request → rate limit → forward to DO stub → normalize response → return.

### 1b. `platform-worker/src/env.ts`

Remove `REC_ENABLE_RANK_KV` — it only gated the now-dead KV ranking path:

```ts
// Remove this line:
REC_ENABLE_RANK_KV?: string;
```

---

## 2. Remove legacy `REC_STORE` fallback reads

**File:** `platform-worker/src/domains/rec/articleMetaKv.ts`  
**Effort:** small (~10 lines)  
**Risk:** low — only triggers when `ARTICLE_META` misses; safe once migration confirmed complete

`loadCachedArticleMeta` falls back to `REC_STORE.get(articleMetaCacheKey(id))` when `ARTICLE_META` misses. This:
- Burns shared KV read quota on the old key schema (`article-meta:<id>`)
- Is a holdover from before `ARTICLE_META` was the canonical namespace

**Fix:** Remove the `REC_STORE` fallback block in `loadCachedArticleMeta`. Confirm that `ARTICLE_META` coverage is complete before merging (check the `/rec/debug` KV counters — if `kvMisses` on `ARTICLE_META` is near zero, coverage is good).

---

## 3. Pre-warm article metadata on the hourly cron

**File:** `platform-worker/src/domains/rec/index.ts` → `scheduledRec`  
**Effort:** medium  
**Risk:** low — additive only; cron already runs

**Problem (Risk B from design.md):** On a cold isolate, `loadCachedArticleMeta` fans out `Promise.all(ids.map(...get))` across all feed-pool article IDs. With ~400 articles, this fires 400 parallel KV reads in the initial request window before the mem cache (500 entries, 1 h TTL) warms up.

**Fix:** In `scheduledRec`, after the existing `/prune` call, fetch the current item-factors list from the DO and pre-warm the mem cache for the top-N articles. This way, the first real `/rec/articles` request after isolate startup hits mem cache instead of KV:

```ts
export async function scheduledRec(env: Env, ctx: ExecutionContext): Promise<void> {
  const stub = getRecDOStub(env);
  // existing prune
  ctx.waitUntil(stub.fetch(new Request('http://do-internal/prune', { method: 'POST' })));
  // pre-warm: fetch top article IDs from DO, load their meta into mem cache
  ctx.waitUntil(prewarmArticleMeta(env, stub));
}
```

Implementation detail: `prewarmArticleMeta` can call `GET http://do-internal/debug/item-factors-count` to decide if there's anything to warm, then issue a batch `/rec/articles?ids=...` lookup against `ARTICLE_META` to populate the mem cache.

---

## 4. Cloudflare Cache API layer for global GET recommendations

**File:** `platform-worker/src/domains/rec/index.ts` → `handleRec`  
**Effort:** medium  
**Risk:** low — only applied to global mode, not feed-pool

For `GET /recommendations/:userId?limit=n` (no `candidates` param), the response is deterministic per user per hour. The Cloudflare Cache API can serve repeat edge hits for free with no quota:

```ts
// After rate-limit check, before calling DO stub:
const cache = caches.default;
const cacheReq = new Request(request.url, { method: 'GET' });
const cached = await cache.match(cacheReq);
if (cached) return cached; // edge cache hit

// ... DO fetch ...

const res = json(response, request, env);
res.headers.set('Cache-Control', 'private, max-age=3600');
ctx.waitUntil(cache.put(cacheReq, res.clone()));
return res;
```

Note: `private` cache means per-data-center, not globally shared. Feed-pool POSTs are not cacheable this way; do not apply to them.

---

## 5. Ricochet library — optional ergonomic improvements

**Repo:** `victusfate/ricochet`  
**Priority:** low — nothing is broken; these are developer-experience improvements only  

These changes make it easier to extend `RecDO` in downstream projects (like platform-worker).

### 5a. `protected state` instead of `private state`

In `src/RecDO.ts` line 84:

```ts
// Before:
constructor(private state: DurableObjectState, private _env: RecWorkerEnv) {

// After:
constructor(protected state: DurableObjectState, protected _env: RecWorkerEnv) {
```

Currently subclasses must store their own `_state` reference to call `this._state.storage.sql.exec()`. Making `state` `protected` lets subclasses use `this.state` directly — the standard TypeScript pattern for extendable base classes.

### 5b. Export a `RankingCacheEntry` type

Platform-worker defines its own `CacheRow` type inline. Ricochet could export a shared type to keep the schema consistent if multiple callers extend `RecDO`:

```ts
// Add to src/types.ts or src/RecDO.ts
export type RankingCacheEntry = {
  cache_key: string;
  payload: string;
  expires_at: number;  // Unix ms
};
```

### 5c. Export default TTL constants

Platform-worker duplicates TTL values that arguably belong in ricochet:

```ts
// Add to src/types.ts
export const REC_FEED_POOL_CACHE_TTL_MS = 5 * 60 * 1000;   // 5 min
export const REC_GLOBAL_CACHE_TTL_MS    = 60 * 60 * 1000;  // 1 h
```

---

## Summary table

| # | Change | File(s) | Priority | Effort | Risk |
|---|--------|---------|----------|--------|------|
| 1a | Remove dead KV ranking code | `rec/index.ts` | **High** | S | None |
| 1b | Remove `REC_ENABLE_RANK_KV` from env | `env.ts` | **High** | XS | None |
| 2 | Remove legacy `REC_STORE` fallback reads | `articleMetaKv.ts` | **Medium** | S | Low |
| 3 | Pre-warm article meta on cron | `rec/index.ts` | Medium | M | Low |
| 4 | CF Cache API for global GET recs | `rec/index.ts` | Low | M | Low |
| 5a | `protected state` in ricochet RecDO | ricochet `RecDO.ts` | Low | XS | None |
| 5b | Export `RankingCacheEntry` type | ricochet `types.ts` | Low | XS | None |
| 5c | Export default TTL constants | ricochet `types.ts` | Low | XS | None |

Items 1a and 1b can ship together as a single small cleanup PR. Items 2–4 are each their own branch. Items 5a–5c are a single ricochet PR if the maintainer wants them.
