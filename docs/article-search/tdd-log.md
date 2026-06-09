# TDD Log: Article Search

| Slice | Status | Notes |
|---|---|---|
| 1 — articleHistory.ts | ✅ | 8 tests — HISTORY_STORE_MAX, evictOldest, mergeEntry |
| 2 — useFeed write triggers | ✅ | Wired; verified by Playwright smoke test |
| 3 — articleSearch.ts | ✅ | 14 tests — ranking, scopes, dedup, case-insensitive |
| 4 — SearchOverlay.tsx | ✅ | Playwright: overlay open/close, chips, empty state |
| 5 — useHistoryBackfill.ts | ✅ | Background backfill hook wired to App.tsx |
| 6 — App.tsx integration | ✅ | 12/12 smoke checks pass |
