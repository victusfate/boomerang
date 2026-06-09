# TDD Log: Quality Rework

| Slice | Status | Findings | Notes |
|---|---|---|---|
| S1 — D1 hotfixes | ✅ | F-01..F-04, F-07 | buildCandidates extracted + 5 tests; backfill gated on prefsReady |
| S2 — storage hardening | ✅ | F-05, F-21 | put+sweep in one IDB tx; promise-chained kv writes |
| S3 — search polish | ✅ | F-06, F-08..F-12, F-33 | one-shot remote fetch + abort; shared timeAgo/articleNavUrl |
| S4 — hook state discipline | ✅ | F-15..F-20 | F-20 verified real (observer loop) and fixed |
| S5 — component discipline | ✅ | F-27..F-30, F-32, F-33 | focus trap mount-only; pull visuals via DOM ref |
| S6 — worker hardening | ✅ | F-38, F-39, F-41, F-42, F-44, F-46, F-49..F-51, F-54 | F-46: legacy fallback skipped >250 ids (kept cheap common path) |
| S7 — MetaDO rework | ✅ | F-37, F-40, F-45, F-53 | live-verified: HTTP tags → DO → KV → GET /meta; F-45 documented as bounded lossiness |
| S8 — topic/merge correctness | ✅ | F-43, F-14, F-24, F-25, F-26, F-35 | 13 new tests; F-22 verified intentional → skipped |
| S9 — dead code + dup sweep | ✅ | F-55..F-60, F-64 | ~330 lines deleted; all deletions grep-verified |
| S10 — perf pass | ✅ | F-61, F-62/F-57, F-65, F-31 | selector extracted + 4 tests |
| S11 — docs registry | ✅ | F-60 | apiRoutes matches implementation incl. POST /rec/articles |

**Skipped (with reasons):** F-22 (failed-room re-save is intentional relink UX), F-47/F-48/F-52 (product calls: DO-based rate limiting, pages.dev pinning, sync GET auth), F-13 (tombstone redesign — own design doc per D5), F-63 (file splits — ride along future feature work), F-34 (full ARIA tabs pattern), F-36 (uncertain, low).

**Final gates:** news-feed 97/97 tests, typecheck clean, 12/12 Playwright smoke. platform-worker 22/22 tests, typecheck clean, wrangler live checks: /health CORS shape, /meta/tags→DO→KV round trip, 201-batch → 400, POST /rec/articles 200.
