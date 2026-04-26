# TDD log — fast-initial-fetch

| Slice | Status | Notes |
|-------|--------|------|
| 1 | done | Parallel `loadArticlesFromWorker` for P1 vs P2+custom; `fetchTier` on articles; `feedPartition` + node test |
| 2 | done | `fetchTier.ts` + `BACKGROUND_TIER_SCORE_MULTIPLIER` in `scoreArticle` |
| 3 | done | Non-explicit uses `mergeIncrementalAppend` only (removed prepend `mergeFeedBackground`) |
| 4 | pending | Cache write timing / all-P1-disabled edge smoke — optional hardening |
| 5 | pending | optional |
