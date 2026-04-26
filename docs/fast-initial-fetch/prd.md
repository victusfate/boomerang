# PRD — fast-initial-fetch

## Problem

Cold load waits on a **single** aggregated fetch path: the client walks non-YouTube chunks (and custom feeds in the same queue) then YouTube chunks, calling `onBatch` as the cumulative pool grows (`news-feed/src/services/newsService.ts` → `fetchAllSourcesViaWorker`). The user sees the first meaningful feed only after enough work has completed, even though the product already **curates** a smaller “first paint” set via `priority: 1` in `shared/rss-sources.json`.

## Solution (summary)

1. **Split fetches** by **source priority** and **source kind**:
   - **Fast batch:** enabled built-in sources with `priority: 1` only (include YouTube and non-YouTube ids that match, using the same per-type chunking rules as today, but **only** for those ids). No custom OPML in this batch.
   - **Background batch:** enabled built-in sources with `priority: 2` **plus** all enabled **custom** sources. Chunked the same way as today (URL size / worker limits), but logically separate from the fast batch.
2. **Start both** as soon as the initial refresh runs (**parallel**). Render from the fast batch as soon as it has produced the first useful `onBatch` (or final merge for that tier).
3. **Merge & rank:** when the background batch returns, **merge** into the full pool, **re-rank** with a **background-tier penalty** so background/custom items do not sort above the fast-tier content that the user is already reading. **Replace** the current “prepend all brand-new” behavior of `mergeFeedBackground` in `useFeed.ts` for this path with a strategy that **anchors** below existing fast-tier rows (see *Implementation decisions*).

## User stories

1. **As a** reader opening the app on a slow connection, **I want** the first screen of articles to appear as soon as the small curated set has loaded, **so that** I can start reading without waiting for the whole catalog.
2. **As a** reader, **I want** the rest of the sources to load without shuffling the articles I’m already looking at, **so that** I don’t lose my place when the background fetch completes.
3. **As a** reader with many OPML feeds, **I want** the fast path to stay fast, **so that** my import size doesn’t block first paint.

## Implementation decisions

### Config / source of truth

- **Fast vs background** for **built-in** sources: `priority: 1` vs `2` in `shared/rss-sources.json` (see `news-feed/src/types.ts` `NewsSource.priority`). No new JSON fields for v1.
- **Custom sources:** no `priority` field; **always** background batch (Q4: Option B).

### Client fetch (`newsService`)

- Introduce a split pipeline (or refactor `fetchAllSourcesViaWorker`) that:
  - Partitions `activeSources` into **P1** vs **P2** by `priority` (treat **missing** `priority` as `2` to match the type comment: default = background).
  - Runs **fast** and **background** fetches in **parallel** (Promise all or two independent chains).
  - For each of non-YouTube + YouTube sub-queues, **only include ids** belonging to that partition; **custom** only on the **background** chain.
- Preserve **staggered chunking** inside each path (`MAX_FEEDS_PER_BUNDLE`, `MAX_WORK_ITEMS_WHEN_CUSTOM`, sorted queue by feed URL) so Worker subrequest limits stay safe.
- **Tag articles with fetch tier** at merge time (or derive in ranker): e.g. optional `fetchTier: 'fast' | 'background'` on `Article`, or derive: `sourceId` starts with `custom-` ⇒ background; else lookup `NewsSource.priority` from `DEFAULT_SOURCES`.
- `onBatch` / callback contract: `useFeed` must be able to apply **only fast-tier** results first, then **incrementally** merge background without breaking the anchor — may require a new callback shape (e.g. `onBatch({ tier, articles, accumulated })`) or two hooks.

### Ranking (`algorithm` / `rankFeed` / `scoreArticle`)

- Apply a **tier penalty** to **background-tier** articles before sort:
  - Example approaches (pick one in implementation): multiplicative factor `0 < k < 1` on the existing score, or subtract a **large** constant that still preserves ordering *within* background tier.
- Ensure penalty is strong enough that, after re-rank, **no** background article sorts **above** the lowest fast-tier row that was already in the **visible/committed** list (tune against real data). Pair with **merge** logic below, not only math.

### State / UI (`useFeed.ts`)

- Today `mergeFeedBackground` **prepends** `brandNew` to `allArticlesRef` (`[...brandNew, ...allArticlesRef.current]`), which conflicts with “don’t move what’s above.” Replace for background-tier updates with:
  - **Re-rank** the combined pool (fast + background articles), then **reconstruct** the visible list: keep a **stable prefix** (ids the user has already been shown in order) and **append** the remainder from the new ranked list, **or** follow the same high-level idea as *incremental append* in explicit refresh, adapted for “background completion.”
- **Cache write (`feed-cache` doc):** still one persisted pool after both complete (or after fast, then update again — product choice: final write when full merge done to avoid double writes; acceptable if two puts with debounce is simpler — decide in plan).

### Worker (`rss-worker`)

- **No change required** for correctness if the client only changes `include=` (and `customFeeds=`) to split work across two calls. Revisit only if we need a dedicated query param (out of scope unless bundle caching needs a new key).

### Edge cases

- **No P1 sources enabled:** fall back to a **single** background fetch (or run background only) so the app does not block on an empty fast list.
- **YouTube only in P2** for a user: fast batch may be non-YouTube-only; still valid.

## Testing strategy

- **Unit / integration (Vitest where applicable):**
  - Partitioning P1 vs P2 ids and custom-only on background.
  - `rankFeed` with mixed tiers: all fast articles sort before any background article for identical intrinsic scores (construct synthetic articles / prefs).
  - Merge helper: after fake “fast” list is shown, background merge does not insert above the fast prefix.
- **Manual:** Slow 3G, cold cache: time-to-first-article vs main; background arrives later without jank above the fold.

## Out of scope (v1)

- Switching from parallel start to “after first paint” (Option C) — **documented** as future tuning, not v1.
- Per-user or ML-driven “fast batch” composition.
- Worker-side `priority` API (client-side split is enough if `include` stays explicit).

## References (code)

- `news-feed/src/hooks/useFeed.ts` — `mergeFeedBackground`, `applyRankedBatch`, `onBatch`
- `news-feed/src/services/newsService.ts` — `fetchAllSourcesViaWorker`, chunking, `onBatch` cadence
- `news-feed/src/services/algorithm.ts` — `rankFeed`, `scoreArticle`
- `shared/rss-sources.json` — `priority`
- `rss-worker/src/index.ts` — `resolveSources` / `include=`
