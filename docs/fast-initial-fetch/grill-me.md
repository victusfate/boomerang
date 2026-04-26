# Grill-me — fast-initial-fetch

**Slug:** `fast-initial-fetch`

## Q1 — Which sources in the fast first-load batch?

**Decision:** Use the existing `priority: 1` field in `shared/rss-sources.json` (and the corresponding `NewsSource.priority` in app types). `priority: 2` is the background batch. No new axis (no fixed “top 10” count, no per-user first-batch composition beyond enabled sources × priority).

Rationale: Already curated, editable in one place, no new config surface.

## Q2 — When does the background (priority-2) fetch start?

**Decision:** **Option A** — start the priority-1 and priority-2 fetches in parallel as soon as the app kicks off the initial load. Priority-1 results render when they return first (smaller bundle).

**Adjustment path:** If combined load is too large (network / battery / worker pressure), consider **Option C** (kick background after the first batch is rendered / UI settled) without redesigning the split.

Rationale: Independent `/bundle` requests; parallel start minimizes time-to-content for the slow path.

## Q3 — How do priority-2 results merge when they arrive?

**Decision:** **Option B** — merge into the article pool, re-rank, and do not pull the user’s reading position: new rows should not jump above work already on screen from the fast batch.

**Additional rule:** Apply a **ranking penalty** to articles that arrive in the **background / priority-2** tier (and to **custom/OPML** sources per Q4) so that, when the combined list is sorted, those items **do not outrank** already-visible or already-ranked priority-1 content for typical scores. (Exact mechanism: e.g. score multiplier or additive penalty in `scoreArticle` / `rankFeed` using fetch-tier metadata—see PRD.)

**Note:** The current `mergeFeedBackground` in `useFeed.ts` *prepends* “brand new” stories to the in-memory list, which can float new items to the top. This feature will replace or extend that path so background-tier results align with the decisions above (merge + re-rank + stable anchor, not indiscriminate prepend).

## Q4 — Custom OPML sources (no `priority` in JSON)

**Decision:** **Option B** — custom feeds always participate in the **background batch** (same as built-in `priority: 2`), not the fast first batch.

Rationale: Keeps the fast batch bounded even if a user imports many OPML sources.

(If you later want “user-added = fast,” revisit as Option A; not in scope for v1 per this doc.)

## Out of scope (for later)

- Per-user “first batch = top N by weight”
- A third request solely for custom feeds (Option C) unless we need it for perf isolation
