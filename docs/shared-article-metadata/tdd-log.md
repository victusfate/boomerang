# TDD Log — Shared Article Metadata

| Slice | Description | Status |
|-------|-------------|--------|
| S1 | meta-worker scaffold: wrangler.jsonc, KV binding, CORS, GET /health | done |
| S2 | DO WebSocket: connect, subscribe, ping/pong, graceful close + hibernation | done |
| S3 | submitTags (batch): DO accepts, normalises, rate-limits, writes KV | done |
| S4 | Tags broadcast: DO pushes `tags` messages to subscribed clients only | done |
| S5 | catchUp: client sends `since`, DO replies with delta from KV | done |
| S6 | rss-worker: ARTICLE_META KV binding + tags injected into GET /bundle | done |
| S7 | news-feed useMetaWorker hook: connect, subscribe, receive tags, catchUp | done |
| S8 | news-feed auto-submit: after Chrome AI batch, fire batched submitTags | done |
| S9 | news-feed articleTagsMap merge: local + meta tags unified in display | done |
| S10 | news-feed inline tag editor: add/edit tags on article cards in the feed | done |
| S11 | meta-worker: DO SQLite primary store, MAX_TAGS=6, KV 14-day TTL, SQLite catchUp | done |
| S12 | meta-worker: SQLite as index-only, KV 90-day TTL, paginated catchUp, hourly alarm prune | done |
| S13 | meta-worker: replace DO alarm with Cloudflare Cron Trigger + internal POST /prune | done |

---

## S1 — meta-worker scaffold
- **Status**: done
- 3 tests pass: GET /health → 200, OPTIONS → 204, unknown → 404

## S13 — Cron Trigger replaces DO alarm
- **Status**: done
- 1 new test: POST /prune returns 404 at public Worker layer (security boundary verified)
- `alarm()` method and `setAlarm` constructor logic removed from MetaDO
- `prune()` method added to MetaDO — synchronous SQL DELETE, called by DO stub only
- `POST /prune` route added to MetaDO.fetch() — unreachable from public internet
- `scheduled` handler added to index.ts — calls DO stub internally via `ctx.waitUntil`
- `"triggers": { "crons": ["0 * * * *"] }` added to wrangler.jsonc
- Security: Worker.fetch() returns 404 for /prune; only scheduled handler holds DO stub

## S12 — SQLite index-only, KV 90-day TTL, paginated catchUp, DO alarm pruning
- **Status**: done
- 5 new tests pass: tag cap, no-op unchanged, catchUp pagination shape, before= cursor filtering, KV expiry fresh start
- SQLite schema slimmed to `(article_id, updated_at)` only — ~40 bytes/row, ~25M articles before 1 GB
- KV TTL raised to 90 days; SQLite index pruned to 14-day window by hourly DO alarm
- `handleCatchUp`: SQL gives IDs for `[since, before)` window, concurrent KV reads supply tags, returns `hasMore + cursor`
- `useMetaWorker`: follows pagination via `catchUpSinceRef` + `before=cursor` on next request
- Contributor cap removed; no-op early-exit guards against redundant KV writes
- `"remote": true` removed from wrangler.jsonc KV binding (was breaking local tests)
- `CatchUpMsg` gains optional `before?: number`; `CatchUpReplyMsg` gains `hasMore?, cursor?`

## S11 — DO SQLite primary store + tag cap + KV TTL
- **Status**: done
- 3 tests pass: tag cap at 6, catchUp from SQLite survives KV expiry, re-interaction merges from SQLite history
- `kvWrite`: reads from DO SQLite (synchronous, no network hop) → merge → truncate to 6 → write SQLite + KV with 14-day TTL
- `handleCatchUp`: single SQL `WHERE updated_at > ?` replaces paginated KV list + serial GETs
- Constructor: `CREATE TABLE IF NOT EXISTS article_meta (article_id, tags, contributors, updated_at)`
- Constants: `MAX_TAGS_PER_ARTICLE = 6`, `KV_TTL_SECONDS = 14 * 24 * 60 * 60`

## S10 — news-feed inline tag editor
- **Status**: done
- 7 tests pass: addManualTag (add, normalise, ignore empty, dedup), removeManualTag (remove, last tag, absent tag)
- `tagEditorUtils.ts`: pure `addManualTag` / `removeManualTag` helpers
- `useFeed.ts`: `handleAddManualTag` / `handleRemoveManualTag` write to Fireproof `ARTICLE_TAGS_ID`
- `ArticleCard.tsx`: inline `+` button opens text input; Enter/blur commits; × removes pill
- `App.tsx`: `onAddManualTag` / `onRemoveManualTag` wired to all ArticleCards
- CSS: `.label-badge-remove`, `.label-badge-add`, `.label-badge-input`

## S3 — submitTags: normalise, rate-limit, write KV
- **Status**: done
- 7 tests pass: normalise, merge, KV write, union-merge, N=3 cap, batch-size cap, 20 msg/min rate-limit
- KV write debounce dropped (contributor cap already bounds writes to 3/article; simpler + testable)

## S2 — DO WebSocket connect + hibernation
- **Status**: done
- 4 tests pass: 101 upgrade + welcome, reconnect → welcome again, pong handling, 426 for non-WS
- `webSocketOpen` fires on hibernation wake; welcome sent eagerly from `fetch()` for first-connect compatibility in miniflare
