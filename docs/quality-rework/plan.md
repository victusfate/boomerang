# Plan: Quality Rework — Vertical Slices

Execution on branch `claude/custom-news-feed-app-NcrzS` (PR #66). Commit per slice. Full gate after each slice: `tsc --noEmit` + `npm test` + Playwright smoke where UI-affecting.

| Slice | Scope | Findings |
|---|---|---|
| S1 | **D1 hotfixes**: backfill gating, out-of-pool search candidates (pure fn + tests), dequeue history fallback, CSS vars, pull-to-refresh gating | F-01..F-04, F-07 |
| S2 | **Storage hardening**: articleHistory put+sweep, recStats/titleCache write serialization | F-05, F-21 |
| S3 | **Search polish**: one-shot remote fetch + abort, counter clamp, URL normalization (shared helper), role fix, shared timeAgo | F-06, F-08..F-12 |
| S4 | **State discipline (hooks)**: stuck loading, fetch token, impure updaters, metaWorker backoff+guard order, AI tagging guard+dedupe, OG sentinel verify/fix | F-15..F-20 |
| S5 | **State discipline (components)**: Settings focus ref + timers + catch, pull indicator via ref, insight memo Map, score badge activation, ArticleCard empty-URL guard | F-27..F-30, F-32, F-33 |
| S6 | **Worker hardening**: bundle/meta caps, R2 onlyIf, paginated deleteRoom, redirect+timeout, CORS cache hygiene, body caps, interactions status check, health CORS, await scheduledRec, parallel KV reads | F-38, F-39, F-41, F-42, F-44, F-46, F-49, F-50, F-51, F-54 |
| S7 | **MetaDO rework**: hibernation rehydration, HTTP tags through DO, guarded broadcast, delete upsertMetaEntry | F-37, F-40, F-45, F-53 |
| S8 | **Topic/merge correctness**: detectTopics word boundaries (fixtures), mergePrefs caps, OPML id/disabled preservation, label filter tightening, sourceWeights decay, adFilter utm verify | F-43, F-14, F-24, F-35, F-25, F-26 |
| S9 | **Dead code + duplication sweep**: deletions (verified by grep), base64/retryAfter/selector/SHOWN_TOPICS/tagEditorUtils extractions, dead CSS | F-55..F-60, F-64 |
| S10 | **Perf pass**: dedupe word-sets, saved-articles memo selector, chunk mapping, fetchTier map, replay Sets, RecDiagnostics memos, debug gating | F-61, F-62, F-65 |
| S11 | **Docs**: apiRoutes registry sync | F-60 |

Uncertain findings are verified before fixing; unverifiable → skipped and logged in tdd-log. Product-call items (F-47, F-48, F-52) and D5 tombstones are explicitly not in this plan.
