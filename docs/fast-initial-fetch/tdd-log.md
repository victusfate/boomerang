# TDD log — fast-initial-fetch

| Slice | Status | Notes |
|-------|--------|------|
| 1 | done | Parallel `loadArticlesFromWorker` for P1 vs P2+custom; `fetchTier` on articles; `feedPartition` + node test |
| 2 | done | `fetchTier.ts` + `BACKGROUND_TIER_SCORE_MULTIPLIER` in `scoreArticle` |
| 3 | done | Non-explicit uses `mergeIncrementalAppend` only (removed prepend `mergeFeedBackground`) |
| 4 | done | Background fetch error silenced in `fetchAllSourcesSplit` — fast-tier articles stay visible without error banner if P2 request throws |
| 5 | n/a | Deferred background start (Option C) — not needed; parallel start (Option A) in production |
