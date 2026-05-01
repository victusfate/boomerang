# Plan — Shared Article Metadata

Vertical slices. Each cuts through all layers end-to-end.

## Original slices (S1–S13)

| Slice | Description | Status |
|-------|-------------|--------|
| S1 | meta-worker scaffold: wrangler.jsonc, KV binding, CORS, GET /health | done |
| S2 | DO WebSocket: connect, subscribe, ping/pong, graceful close + hibernation | done |
| S3 | submitTags (batch): DO accepts, normalises, rate-limits, writes KV | done |
| S4 | Tags broadcast: DO pushes `tags` messages to subscribed clients only | done |
| S5 | catchUp: client sends `since`, DO replies with delta from KV | done |
| S6 | rss-worker: ARTICLE_META KV binding + tags injected into GET /bundle | done → removed (see F1) |
| S7 | news-feed useMetaWorker hook: connect, subscribe, receive tags, catchUp | done |
| S8 | news-feed auto-submit: after Chrome AI batch, fire batched submitTags | done |
| S9 | news-feed articleTagsMap merge: local + meta tags unified in display | done |
| S10 | news-feed inline tag editor: add/edit tags on article cards in the feed | done |
| S11 | meta-worker: DO SQLite primary store, MAX_TAGS=6, KV 14-day TTL, SQLite catchUp | done |
| S12 | meta-worker: SQLite index-only, KV 90-day TTL, paginated catchUp, hourly alarm prune | done |
| S13 | meta-worker: replace DO alarm with Cloudflare Cron Trigger + POST /prune | done |

## Post-plan fixes and optimisations (F1–F10)

These were not in the original plan. Each addresses a bug or performance issue
found during testing on the deployed workers.

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
| F9 | sync-worker: poll 30s → 5 min + skip push when payload unchanged | done |
| F10 | sync-worker: implement applyRemoteSync — live merge of saved articles and prefs | done |

---

## S1 — meta-worker scaffold

**Files:** `meta-worker/wrangler.jsonc`, `meta-worker/package.json`,
`meta-worker/tsconfig.json`, `meta-worker/src/index.ts`,
`meta-worker/vitest.config.mts`

**Wrangler bindings:**
```jsonc
{
  "name": "boomerang-meta",
  "main": "src/index.ts",
  "compatibility_date": "2026-04-09",
  "kv_namespaces": [{ "binding": "ARTICLE_META", "id": "<id>" }],
  "durable_objects": {
    "bindings": [{ "name": "META_DO", "class_name": "MetaDO" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["MetaDO"] }]
}
```

**Routes:** `GET /health` → `{ ok: true, service: "boomerang-meta" }`.
CORS headers for allowed origins (same list as rss-worker).

**Tests:** GET /health → 200, OPTIONS preflight → 204, unknown path → 404.

---

## S2 — DO WebSocket connect + hibernation

**Files:** `meta-worker/src/MetaDO.ts`

**Behaviour:**
- `GET /ws` → worker upgrades to WebSocket, passes to DO via `stub.fetch()`
- DO accepts via hibernation API (`this.ctx.acceptWebSocket(ws)`)
- On open: DO sends `{ type: "welcome" }`
- On close / error: cleanup subscription state
- Heartbeat: DO pings every 30s; client pongs; DO closes stale connections
  after 2 missed pongs

**Tests:** WS connect → welcome message; hibernation round-trip (connect,
disconnect, reconnect, welcome again).

---

## S3 — submitTags: normalise, rate-limit, write KV

**Files:** `meta-worker/src/MetaDO.ts`, `meta-worker/src/tags.ts`

**Behaviour:**
- DO receives `{ type: "submitTags", articles: [{ articleId, tags }] }`
- Validates: batch max 200; per-connection 20 msg/min (tracked in DO memory)
- Per article: lowercase+trim+dedup tags; skip if contributors >= 3
- KV write debounced 5s per articleId (collapses rapid submissions)
- KV value: `{ articleId, tags: string[], updatedAt: number, contributors: number }`

**`tags.ts` exports:** `normaliseTags(raw: string[]): string[]`,
`mergeTagSets(a: string[], b: string[]): string[]`

**Tests:** normalise, merge, contributor cap enforcement, batch size cap,
message rate cap, KV debounce (fast-clock mock).

---

## S4 — Tags broadcast to subscribed clients

**Files:** `meta-worker/src/MetaDO.ts`

**Behaviour:**
- On `{ type: "subscribe", articleIds }`: DO stores articleIds for that WS
  session in DO memory (not persisted — ephemeral per connection)
- After KV write for an articleId, DO iterates all active WebSocket sessions,
  sends `{ type: "tags", articleId, tags, updatedAt }` only to sessions
  subscribed to that articleId
- Uses `this.ctx.getWebSockets()` (hibernation API)

**Tests:** two connected clients, one subscribes to articleId A, one to B;
submitTags for A → only subscriber A receives broadcast.

---

## S5 — catchUp on reconnect

**Files:** `meta-worker/src/MetaDO.ts`

**Behaviour:**
- Client sends `{ type: "catchUp", since: epochMs }`
- DO scans KV for all entries with `updatedAt > since`
  (KV list + get, filtered by timestamp; acceptable at small scale)
- Replies `{ type: "catchUp", updates: [{ articleId, tags, updatedAt }] }`
- If `since` is 0 or absent, returns all known entries (full sync)

**Tests:** submit tags for 3 articles at t=100, catchUp since t=50 returns
all 3; catchUp since t=150 returns empty.

---

## S6 — rss-worker: KV binding + tags in bundle (removed by F1)

Originally injected tags from KV into the `/bundle` JSON response. Removed
because batch KV reads (one `get()` per article) hit the Cloudflare
subrequest-per-invocation limit (~500k articles → 500 errors). The
meta-worker WebSocket's catchUp on connect is the canonical way to get
initial tag state for the current feed; the rss-worker no longer reads KV.

---

## S7 — news-feed useMetaWorker hook

**Files:** `news-feed/src/hooks/useMetaWorker.ts`,
`news-feed/src/vite-env.d.ts`, `news-feed/src/services/metaWorker.ts`

**Behaviour:**
- Opens WebSocket to `VITE_META_WORKER_URL/ws`
- On connect: sends `subscribe` for current articleIds + `catchUp since=lastTagsAt`
- On `tags` message: updates `metaTagsMap` state (Map<articleId, string[]>)
- On `catchUp` message: bulk-updates `metaTagsMap`; follows `hasMore` pagination
- On visibility change / disconnect: reconnects with same pattern

**Fix (F5):** `subscribe` is re-sent when `articleIds` prop changes so the DO
receives new article IDs as progressive loading adds cards. `catchUp` is
always sent on connect (was gated on `since > 0`, blocking fresh browsers).

---

## S8 — Auto-submit batch after Chrome AI tagging

**Files:** `news-feed/src/hooks/useFeed.ts`, `news-feed/src/hooks/useMetaWorker.ts`

**Behaviour:**
- `useMetaWorker` exposes `feedTaggedArticle(articleId, tags)` and `endTaggingPass()`
- `useFeed` calls `feedTaggedArticle` per article as Chrome AI tags it (streaming)
- Buffer flushes when: buffer hits 200 articles OR 20 s elapses since first entry
- `endTaggingPass()` drains the buffer immediately when the pass ends
- Flush sends one `submitTags` WS message per batch

---

## S9 — articleTagsMap merge: local + meta

**Files:** `news-feed/src/hooks/useFeed.ts`, `news-feed/src/App.tsx`

**Behaviour:**
- `useFeed` receives `metaTagsMap` from `useMetaWorker`
- `articleTagsMap` = union of local Fireproof tags and meta-worker tags per articleId
- Meta tags are display-only; not written to Fireproof

---

## S10 — Inline tag editor on article cards

**Files:** `news-feed/src/components/ArticleCard.tsx`, `news-feed/src/App.css`

**Behaviour:**
- Tag pills rendered on each card
- `+` button → opens inline text input; Enter/blur commits tag
- `×` on pill → removes tag
- Writes to Fireproof `ai-article-tags` doc via `useFeed`

---

## S11 — meta-worker: DO SQLite primary store

**Files:** `meta-worker/src/MetaDO.ts`

- DO SQLite table `article_meta(article_id, tags, contributors, updated_at)`
- `MAX_TAGS_PER_ARTICLE = 6`; `KV_TTL_SECONDS = 14 days`
- `handleCatchUp` reads from SQLite (no KV round-trips)

---

## S12 — meta-worker: SQLite index-only + paginated catchUp

**Files:** `meta-worker/src/MetaDO.ts`, `meta-worker/src/worker.test.ts`

- Schema slimmed to `(article_id, updated_at)` only; tags stay in KV
- KV TTL raised to 90 days
- `handleCatchUp` paginates via `hasMore + cursor`; client follows pages

---

## S13 — meta-worker: Cron Trigger replaces DO alarm

**Files:** `meta-worker/src/MetaDO.ts`, `meta-worker/src/index.ts`,
`meta-worker/wrangler.jsonc`

- `scheduled` handler in index.ts calls DO stub's internal `POST /prune`
- DO's `prune()` deletes SQLite rows older than 14 days
- `POST /prune` returns 404 at the public Worker layer (unreachable externally)
- `"crons": ["0 * * * *"]` in wrangler.jsonc

---

## F1 — rss-worker: remove buildTagsMap

**Files:** `rss-worker/src/index.ts`, `rss-worker/wrangler.jsonc`,
`rss-worker/worker-configuration.d.ts`, `rss-worker/src/worker.test.ts`

**Problem:** `buildTagsMap` issued one `kv.get()` per article in the bundle
response. With hundreds of articles, this exceeded Cloudflare's
subrequest-per-invocation limit and returned HTTP 500.

**Fix:** Removed `buildTagsMap`, the `ARTICLE_META` KV binding, and the `tags`
field from `/bundle`. The meta-worker WebSocket + `catchUp` is the correct path
for initial tag state.

---

## F2 — rss-worker: og-image 404 not 502

**Files:** `rss-worker/src/index.ts`

Changed error responses in `/og-image` from 502 (Bad Gateway, implies worker
infrastructure failure) to 404 (Not Found, accurately describes a missing image).

---

## F3 — news-feed: fix live tag display

**Files:** `news-feed/src/hooks/useFeed.ts`

**Problem:** `setArticleTags` was wrapped in `startTransition`, marking it as
non-urgent. React indefinitely deferred the update because `setClassificationStatus`
(urgent) fired on every article, always pre-empting the deferred update.

**Fix:** Removed `startTransition` from `setArticleTags`. Both state updates
now commit in the same render, making tags appear on cards immediately as
Chrome AI produces them.

---

## F4 — news-feed: feed-order tagging + pulsing indicator

**Files:** `news-feed/src/services/labelClassifier.ts`,
`news-feed/src/hooks/useFeed.ts`, `news-feed/src/App.tsx`,
`news-feed/src/components/ArticleCard.tsx`, `news-feed/src/App.css`

- `labelClassifier.ts`: added `articleId?` param to `onArticleStart` hook so
  the currently-tagging article can be identified
- `useFeed.ts`: sorts articles by ranked feed position before the tagging pass;
  exposes `taggingArticleId` state; clears it on pass end/error/skip
- `ArticleCard.tsx`: `isTagging` prop renders a pulsing accent dot in the
  card metadata row while that card is being tagged
- CSS: `.card-tagging-dot` uses the same `pulse` keyframe as `.ai-status-dot`

---

## F5 — meta-worker: reconnect fixes

**Files:** `news-feed/src/hooks/useMetaWorker.ts`

Two bugs that broke cross-browser tag sync:

1. **`subscribe` not re-sent on articleIds change** — when progressive loading
   added new articles to the feed, the DO never received their IDs and silently
   dropped broadcasts for them. Fixed: re-send `subscribe` in a `useEffect`
   watching `articleIds`.

2. **`catchUp` gated on `since > 0`** — a fresh browser with `lastTagsAt=0`
   never sent `catchUp`, so it never received any stored tags. Fixed: always
   send `catchUp` on connect; `since=0` fetches all stored tags.

---

## F6 — sync diagnostics

**Files:** `news-feed/src/hooks/useMetaWorker.ts`,
`news-feed/src/hooks/useSyncWorker.ts`

Added `console.info` logging on both sync paths so the source of each update
is visible in browser devtools:

- `[sync:meta-worker] broadcast` — real-time tag push from DO WebSocket
- `[sync:meta-worker] catchUp` — bulk tag fetch on connect/reconnect
- `[sync:sync-worker] poll merged` — diff summary after each 30s poll (later
  5 min), showing `newTaggedArticles`, `newSavedArticles`, `newSavedIds` counts
  and samples

---

## F7 — og-image: batch hook + localStorage cache

**Files:** `news-feed/src/hooks/useOGImageBatch.ts` (new),
`news-feed/src/components/ArticleCard.tsx`, `news-feed/src/App.tsx`

**Problem:** Each `ArticleCard` ran its own `useLazyOGImage` hook with an
`IntersectionObserver`. State was local React state — reset on every page load.
With ~50 articles visible, this fired ~50 Worker requests on every page load,
driving ~50k req/day against the 100k/day free-tier limit.

**Fix:**
- New `useOGImageBatch(articles, batchSize=10)` hook owns all og-image fetching
- `localStorage` cache key `og_cache_v1` (24h TTL): repeat page loads skip
  the Worker entirely for all previously-seen URLs
- Scroll-triggered in batches of 10 via a single sentinel `<div>` rendered
  after the Nth card; when visible, next batch of 10 is fetched
- `ArticleCard` receives `ogImageUrl?: string` as a prop; prefers RSS image,
  falls back to og-image (including when the RSS image fails to load)
- Per-card `IntersectionObserver` and `fetchOGImage` function removed from
  `ArticleCard.tsx`

**Cost impact:** ~50k req/day → near-zero after first visit per device.

---

## F8 — rss-worker: og-image Cache-Control fix

**Files:** `rss-worker/src/index.ts`

The `json()` helper used `BUNDLE_CACHE_TTL_SEC` (300 s = 5 min) for all JSON
responses including og-image. The `/og-image` endpoint should cache for 24 h
(same as image proxy). Added optional `ttl` param to `json()`, defaulting to
`BUNDLE_CACHE_TTL_SEC`; og-image calls pass `IMAGE_PROXY_CACHE_TTL_SEC` (86 400 s).

---

## F9 — sync-worker: cost reduction

**Files:** `news-feed/src/hooks/useSyncWorker.ts`

Two changes to reduce Cloudflare Worker request consumption:

1. **Poll interval 30 s → 5 min** — saves ~1 700 GET requests/day per 2-browser
   session. The `visibilitychange` handler still fires an immediate poll when
   a tab gains focus, so real-world sync latency is "on next tab focus" not
   "5 minutes."

2. **Skip push when payload unchanged** — `doPush` compares the current payload
   JSON against the last successfully pushed payload; skips the PUT if equal.
   Prevents redundant pushes from the 5-minute debounce firing with no state
   change. On conflict, `lastPushedRef` is not updated so the retry always
   re-pushes.

---

## F10 — sync-worker: live merge implementation

**Files:** `news-feed/src/hooks/useFeed.ts`, `news-feed/src/App.tsx`

**Problem:** `handleSyncMerge` in App.tsx was a stub with the comment
"handled as follow-up." Every sync-worker poll delivered a merged payload
(prefs, saved articles, tags) that was immediately discarded. Chrome showed
"Loading saved articles…" because it had `savedIds` in local prefs but the
`Article` objects from Brave's saves were never written to Fireproof.

**Fix:** Added `applyRemoteSync` to `useFeed` — mirrors the startup URL-hash
sync path but callable at any time:
- Merges remote prefs (including `savedIds`) into local prefs → `updatePrefs` → Fireproof
- Merges remote saved articles into `importedSaves` (non-RSS-pool articles only;
  pool articles show via `savedIds` automatically) → Fireproof
- Merges `labelHits` and `articleTags` with length-change guard to skip no-op
  Fireproof writes

`App.tsx` wires `handleSyncMerge = onRemoteSync` so every sync-worker poll now
applies its merged payload.
