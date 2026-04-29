# Plan — Shared Article Metadata

Vertical slices. Each cuts through all layers end-to-end.

| Slice | Description |
|-------|-------------|
| S1 | meta-worker scaffold: wrangler.jsonc, KV binding, CORS, GET /health |
| S2 | DO WebSocket: connect, subscribe, ping/pong, graceful close + hibernation |
| S3 | submitTags (batch): DO accepts, normalises, rate-limits, writes KV |
| S4 | Tags broadcast: DO pushes `tags` messages to subscribed clients only |
| S5 | catchUp: client sends `since`, DO replies with delta from KV |
| S6 | rss-worker: ARTICLE_META KV binding + tags injected into GET /bundle |
| S7 | news-feed useMetaWorker hook: connect, subscribe, receive tags, catchUp |
| S8 | news-feed auto-submit: after Chrome AI batch, fire batched submitTags |
| S9 | news-feed articleTagsMap merge: local + meta tags unified in display |
| S10 | news-feed inline tag editor: add/edit tags on article cards in the feed |

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
- Validates: batch max 50; per-connection 20 msg/min (tracked in DO memory)
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

## S6 — rss-worker: KV binding + tags in bundle

**Files:** `rss-worker/wrangler.jsonc`, `rss-worker/src/index.ts`,
`rss-worker/worker-configuration.d.ts`

**Behaviour:**
- Add `ARTICLE_META` KV binding (same namespace id as meta-worker)
- After `fetchFeedsStaggered` resolves, collect all articleIds from response
- Batch-read KV: `Promise.all(ids.map(id => env.ARTICLE_META.get('meta:' + id, 'json')))`
- Attach to bundle response: `tags: { [articleId]: string[] }`
- KV miss → omit that articleId from tags map (not an error)

**Tests:** bundle response includes `tags` field; KV miss → empty tags object;
KV hit → correct tags for articleId.

---

## S7 — news-feed useMetaWorker hook

**Files:** `news-feed/src/hooks/useMetaWorker.ts`,
`news-feed/src/vite-env.d.ts` (add `VITE_META_WORKER_URL`),
`news-feed/src/services/metaWorker.ts` (URL builder, message types)

**Behaviour:**
- Opens WebSocket to `VITE_META_WORKER_URL/ws` (default:
  `https://boomerang-meta.boomerang.workers.dev`)
- On connect: sends `{ type: "subscribe", articleIds }`
- On `tags` message: updates `metaTagsMap` state (Map<articleId, string[]>)
- On `catchUp` message: bulk-updates `metaTagsMap`
- On visibility change / disconnect: reconnects with `{ type: "catchUp", since: lastTagsAt }`
- Returns `{ metaTagsMap, submitTags }`

**Tests (node:test):** message parsing, metaTagsMap update logic, catchUp
timestamp tracking.

---

## S8 — Auto-submit batch after Chrome AI tagging

**Files:** `news-feed/src/hooks/useFeed.ts`,
`news-feed/src/hooks/useMetaWorker.ts`

**Behaviour:**
- After `runTaggingPass` completes in `useFeed`, collect newly-tagged
  `{ articleId, tags }` pairs
- Call `submitTags(newlyTagged)` from `useMetaWorker`
- Hook batches into max-50-article chunks, sends each as one WS message
- No UI change — entirely background

**Tests:** tagging 60 articles produces 2 WS messages (50 + 10); tags are
normalised before send.

---

## S9 — articleTagsMap merge: local + meta

**Files:** `news-feed/src/hooks/useFeed.ts`, `news-feed/src/App.tsx`

**Behaviour:**
- `useFeed` receives `metaTagsMap` as a prop/param from `useMetaWorker`
- `articleTagsMap` = union of local Fireproof tags + meta tags per articleId
- Meta tags are not written to Fireproof; local tags are not sent to meta-worker
  (Chrome AI auto-submit from S8 is the only write path)
- `App.tsx`: wire `useMetaWorker`, pass `metaTagsMap` into `useFeed`

**Tests:** merge logic: local `["ai"]` + meta `["climate"]` → `["ai","climate"]`;
meta tags never appear in Fireproof writes.

---

## S10 — Inline tag editor on article cards

**Files:** `news-feed/src/components/ArticleCard.tsx`,
`news-feed/src/App.css`

**Behaviour:**
- Tag pills rendered on each card (already exist for local tags)
- Add `+` button after last pill → opens inline text input on the card
- On enter/blur: calls `onAddManualTag(articleId, tagText)` → writes to
  Fireproof via `useFeed` → appears in local tags immediately
- Existing pill: tap-to-edit inline, enter to confirm, × to remove
- No Settings panel required

**Tests:** tag add flow (renders input, calls handler); tag remove; empty
input ignored.
