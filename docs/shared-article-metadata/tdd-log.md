# TDD Log — Shared Article Metadata

## Original slices

| Slice | Description | Status |
|-------|-------------|--------|
| S1 | meta-worker scaffold: wrangler.jsonc, KV binding, CORS, GET /health | done |
| S2 | DO WebSocket: connect, subscribe, ping/pong, graceful close + hibernation | done |
| S3 | submitTags (batch): DO accepts, normalises, rate-limits, writes KV | done |
| S4 | Tags broadcast: DO pushes `tags` messages to subscribed clients only | done |
| S5 | catchUp: client sends `since`, DO replies with delta from KV | done |
| S6 | rss-worker: ARTICLE_META KV binding + tags injected into GET /bundle | done → removed (F1) |
| S7 | news-feed useMetaWorker hook: connect, subscribe, receive tags, catchUp | done |
| S8 | news-feed auto-submit: after Chrome AI batch, fire batched submitTags | done |
| S9 | news-feed articleTagsMap merge: local + meta tags unified in display | done |
| S10 | news-feed inline tag editor: add/edit tags on article cards in the feed | done |
| S11 | meta-worker: DO SQLite primary store, MAX_TAGS=6, KV 14-day TTL, SQLite catchUp | done |
| S12 | meta-worker: SQLite index-only, KV 90-day TTL, paginated catchUp, hourly alarm prune | done |
| S13 | meta-worker: replace DO alarm with Cloudflare Cron Trigger + POST /prune | done |

## Post-plan fixes and optimisations

| Fix | Description | Status |
|-----|-------------|--------|
| F1 | rss-worker: remove buildTagsMap — eliminates subrequest limit 500 | done |
| F2 | rss-worker: og-image fetch failure returns 404 not 502 | done |
| F3 | news-feed: remove startTransition from setArticleTags — fix live tag display | done |
| F4 | news-feed: tag articles in feed order + pulsing dot on active card | done |
| F5 | meta-worker: re-subscribe on articleIds change + always send catchUp on connect | done |
| F6 | sync diagnostics: console logging for meta-worker and sync-worker activity | done |
| F7 | og-image: centralized batch hook (N=10) + localStorage cache (24h TTL) | done |
| F8 | rss-worker: og-image Cache-Control fix — 5 min → 24 h on CF edge cache | done |
| F9 | sync-worker: poll 30 s → 5 min + skip push when payload unchanged | done |
| F10 | sync-worker: implement applyRemoteSync — live merge of saved articles and prefs | done |

---

## S1 — meta-worker scaffold
- **Status**: done
- 3 tests pass: GET /health → 200, OPTIONS → 204, unknown → 404

## S2 — DO WebSocket connect + hibernation
- **Status**: done
- 4 tests pass: 101 upgrade + welcome, reconnect → welcome again, pong handling, 426 for non-WS
- `webSocketOpen` fires on hibernation wake; welcome sent eagerly from `fetch()` for first-connect
  compatibility in miniflare

## S3 — submitTags: normalise, rate-limit, write KV
- **Status**: done
- 7 tests pass: normalise, merge, KV write, union-merge, N=3 cap, batch-size cap, 20 msg/min rate-limit
- KV write debounce dropped (contributor cap already bounds writes to 3/article; simpler + testable)

## S4 — Tags broadcast to subscribed clients
- **Status**: done
- Covered by integration tests in S3 suite

## S5 — catchUp delta from KV
- **Status**: done
- Tests: 3-article submit at t=100; catchUp since t=50 returns all 3; since t=150 returns empty

## S6 — rss-worker KV binding + tags in bundle
- **Status**: removed (see F1)
- Was done; removed when subrequest-limit crashes appeared on the deployed worker

## S7 — news-feed useMetaWorker hook
- **Status**: done
- WebSocket connect, subscribe, receive `tags` + `catchUp` messages, reconnect on close

## S8 — news-feed auto-submit tags
- **Status**: done
- `feedTaggedArticle` buffers tags; `endTaggingPass` drains buffer immediately
- `FLUSH_INTERVAL_MS = 20_000` (20 s) after iterating to 0 → 500 → back to 20 000 for cost reasons

## S9 — articleTagsMap merge: local + meta
- **Status**: done
- `useFeed` merges Fireproof local tags and meta-worker `metaTagsMap` per articleId

## S10 — news-feed inline tag editor
- **Status**: done
- 7 tests pass: addManualTag (add, normalise, ignore empty, dedup), removeManualTag (remove, last, absent)
- `tagEditorUtils.ts`: pure `addManualTag` / `removeManualTag` helpers
- `useFeed.ts`: `handleAddManualTag` / `handleRemoveManualTag` write to Fireproof `ARTICLE_TAGS_ID`
- `ArticleCard.tsx`: `+` button opens text input; Enter/blur commits; `×` removes pill
- CSS: `.label-badge-remove`, `.label-badge-add`, `.label-badge-input`

## S11 — meta-worker: DO SQLite primary store + tag cap + KV TTL
- **Status**: done
- 3 tests pass: tag cap at 6, catchUp from SQLite survives KV expiry, re-interaction merges from SQLite history
- `kvWrite`: reads from DO SQLite → merge → truncate to 6 → write SQLite + KV with 14-day TTL
- `handleCatchUp`: single SQL `WHERE updated_at > ?` replaces paginated KV list + serial GETs
- Constructor: `CREATE TABLE IF NOT EXISTS article_meta (article_id, tags, contributors, updated_at)`

## S12 — meta-worker: SQLite index-only, KV 90-day TTL, paginated catchUp
- **Status**: done
- 5 new tests pass: tag cap, no-op unchanged, catchUp pagination shape, before= cursor filtering, KV expiry fresh start
- SQLite schema slimmed to `(article_id, updated_at)` — ~40 bytes/row, ~25M articles before 1 GB
- KV TTL raised to 90 days; SQLite index pruned to 14-day window by hourly DO alarm
- `handleCatchUp`: SQL gives IDs for `[since, before)` window; concurrent KV reads supply tags
- `useMetaWorker`: follows pagination via `catchUpSinceRef` + `before=cursor` on next request
- `CatchUpMsg` gains optional `before?: number`; `CatchUpReplyMsg` gains `hasMore?, cursor?`

## S13 — Cron Trigger replaces DO alarm
- **Status**: done
- 1 new test: POST /prune returns 404 at public Worker layer (security boundary verified)
- `alarm()` method and `setAlarm` constructor logic removed from MetaDO
- `prune()` method added to MetaDO — synchronous SQL DELETE, called by DO stub only
- `POST /prune` route added to MetaDO.fetch() — unreachable from public internet
- `scheduled` handler added to index.ts — calls DO stub internally via `ctx.waitUntil`
- `"triggers": { "crons": ["0 * * * *"] }` added to wrangler.jsonc

---

## F1 — rss-worker: remove buildTagsMap
- **Status**: done
- **Root cause**: `buildTagsMap` issued one `kv.get()` per article. Hundreds of articles
  per bundle → exceeded Cloudflare's subrequest-per-invocation limit → HTTP 500 on deployed worker.
  Log showed "Too many API requests by single Worker invocation", `cpuTimeMs: 588`, `wallTimeMs: 12466`.
- Removed `buildTagsMap`, `ARTICLE_META` KV binding from rss-worker, and `tags` field from `/bundle`.
  The `client never consumed the tags field from bundle` — it was dead code from S6.
- `rss-worker/src/worker.test.ts`: removed S6 describe block.
- 4 remaining tests still pass.

## F2 — rss-worker: og-image 404 not 502
- **Status**: done
- 502 (Bad Gateway) implies the Worker itself failed; 404 accurately describes "image not found."
- Changed upstream-fetch-failed and HTML-response branches in `/og-image` handler.

## F3 — news-feed: fix live tag display
- **Status**: done
- **Root cause**: `startTransition(() => setArticleTags(...))` marked tag updates as non-urgent.
  `setClassificationStatus` (no `startTransition`) fired on every article, always pre-empting
  the deferred update. Tags were generated (visible in console) but never appeared on cards.
- Fix: removed `startTransition` from `setArticleTags`. Both updates now commit in the same render.

## F4 — news-feed: feed-order tagging + pulsing indicator
- **Status**: done
- Articles were tagged in `articlePool` insertion order (random). Now sorted by ranked feed
  position before the tagging pass so visible cards are tagged first.
- `labelClassifier.ts`: `onArticleStart?(index, total, articleId?)` — articleId added.
- `useFeed.ts`: `taggingArticleId` state; cleared on pass end/error/skip.
- `ArticleCard.tsx`: `isTagging?: boolean` prop → `.card-tagging-dot` (pulsing accent dot).
- CSS: `.card-tagging-dot` uses the shared `pulse` keyframe.

## F5 — meta-worker: reconnect fixes
- **Status**: done
- **Bug 1**: `subscribe` only sent on initial connect. As progressive loading added articles,
  the DO never received their IDs → no broadcasts for those articles in any browser tab.
  Fix: `useEffect` on `articleIds` re-sends `subscribe` when list changes and WS is open.
- **Bug 2**: `catchUp` gated with `if (since > 0)`. Fresh browser (Brave with `lastTagsAt=0`)
  never fetched stored tags. Fix: always send `catchUp`; `since=0` fetches full history.

## F6 — sync diagnostics
- **Status**: done
- `[sync:meta-worker] broadcast`: article ID, tags, updatedAt ISO string.
- `[sync:meta-worker] catchUp`: update count, `hasMore`, cursor, 3-entry sample.
- `[sync:sync-worker] poll merged`: `newTaggedArticles`, `newSavedArticles`, `newSavedIds`
  counts with 3-entry samples, so the source of each merge is visible in devtools.

## F7 — og-image: batch hook + localStorage cache
- **Status**: done
- **Root cause**: each card's `useLazyOGImage` used local React state (reset on page load)
  + `IntersectionObserver`. With ~50 cards, every page load fired ~50 Worker requests.
  og-image JSON also used `BUNDLE_CACHE_TTL_SEC` (5 min) so the CF edge cache barely helped.
  Result: ~50k req/day from og-image alone against the 100k/day free-tier cap.
- New `useOGImageBatch(articles, batchSize=10)`:
  - `localStorage` key `og_cache_v1` (24h TTL) → cache hits are instant, no Worker request
  - Sentinel `<div>` rendered after the Nth card; `IntersectionObserver` on it triggers the
    next batch of 10 when scrolled into view (scroll-triggered, not per-card)
  - `initiated` ref prevents double-fetching; parallel `Promise.allSettled` per batch
  - Both null (tried, no image) and resolved URLs stored in cache to prevent retry storms
- `ArticleCard`: removed `useLazyOGImage`, `fetchOGImage`, `resolveArticleImageUrl`.
  Accepts `ogImageUrl?: string | null`; local `imgFailed` state selects between RSS and og-image.
- `App.tsx`: `Fragment` wraps each card + sentinel; passes `ogImageUrl={ogMap.get(article.id)}`.

## F8 — rss-worker: og-image Cache-Control fix
- **Status**: done
- `json()` helper hardcoded `BUNDLE_CACHE_TTL_SEC` (300 s) for all JSON responses.
- Added optional `ttl` param (default `BUNDLE_CACHE_TTL_SEC`); og-image calls pass
  `IMAGE_PROXY_CACHE_TTL_SEC` (86 400 s = 24 h).
- Complements F7: even without the localStorage cache, the CF edge cache now holds
  og-image responses for 24 h instead of 5 min.

## F9 — sync-worker: cost reduction
- **Status**: done
- `POLL_INTERVAL_MS`: 30 000 → 300 000 (5 min). Saves ~1 700 GET requests/day per 2-browser
  session (30 s × 2 browsers × 8 hr/day = 1 920 → 192). `visibilitychange` still fires
  an immediate poll on tab focus so real-world latency is unaffected.
- Skip-push guard: `doPush` JSON-serialises the payload and compares to `lastPushedRef`.
  Returns early if unchanged. `lastPushedRef` updated only on successful non-conflict push.

## F10 — sync-worker: live merge implementation
- **Status**: done
- **Root cause**: `handleSyncMerge` in App.tsx was a no-op stub ("handled as follow-up").
  Every sync-worker poll delivered merged data that was immediately discarded.
  Chrome showed "Loading saved articles…" because it had `savedIds` from its own saves
  but the `Article` objects synced from Brave were never written to Fireproof.
- Added `applyRemoteSync` to `useFeed` (mirrors startup URL-hash sync path):
  - `mergePrefs` → `updatePrefs` → Fireproof `user-prefs`
  - `mergeArticlesById` for non-pool saved articles → `setImportedSaves` → Fireproof `imported-saves`
  - `mergeLabelHits` with length-change guard → Fireproof `ai-classifications`
  - `mergeArticleTags` with length-change guard → Fireproof `ai-article-tags`
- `App.tsx`: `handleSyncMerge = onRemoteSync` (no longer a stub).
