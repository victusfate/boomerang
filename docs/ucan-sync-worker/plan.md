# Implementation Plan — Sync Worker

**Feature slug:** `ucan-sync-worker`  
**Date:** 2026-04-29

Each slice is a vertical tracer bullet: touches all layers end-to-end (worker config → route → client → test). Complete one before starting the next.

---

## S1 — Worker scaffold

**Outcome:** `sync-worker/` exists, deploys with `wrangler deploy`, returns `GET /health → { ok: true }`. R2 bucket bound but unused. CORS mirrors `rss-worker`.

**Files touched:**
- `sync-worker/wrangler.jsonc` — worker name `boomerang-sync`, R2 binding `SYNC_BLOCKS`, compatibility date, observability
- `sync-worker/package.json` — same devDeps as `rss-worker` (wrangler, @cloudflare/workers-types, typescript)
- `sync-worker/tsconfig.json`
- `sync-worker/src/index.ts` — fetch handler, CORS helpers (copy + adapt from `rss-worker`), `/health` route
- `sync-worker/src/cors.ts` — `isAllowedOrigin`, `corsHeaders` (same allowed origins as rss-worker + localhost variants)

**Test:** `wrangler dev` → `curl http://127.0.0.1:8788/health` returns `{"ok":true}`.

---

## S2 — Room creation

**Outcome:** `POST /sync/room` creates a roomId and token, stores the token hash in R2, returns `{ roomId, token }`.

**Files touched:**
- `sync-worker/src/room.ts` — `createRoom(r2: R2Bucket): Promise<{ roomId, token }>`:
  - `roomId` = 32 random bytes → hex string
  - `token` = 32 random bytes → base64url string
  - Store `SHA-256(token)` at `{roomId}/.token` in R2
- `sync-worker/src/index.ts` — add `POST /sync/room` route
- `sync-worker/src/auth.ts` — `verifyToken(r2, roomId, token): Promise<boolean>` — fetch `{roomId}/.token`, compare to `SHA-256(token)`

**Test:** POST `/sync/room` → `{ roomId: string, token: string }`; second POST produces different roomId.

---

## S3 — Block storage

**Outcome:** `PUT /sync/{roomId}/blocks/{cid}` stores opaque bytes; `GET /sync/{roomId}/blocks/{cid}` retrieves them or 404s. PUT requires valid token.

**Files touched:**
- `sync-worker/src/blocks.ts` — `putBlock`, `getBlock` (thin R2 wrappers)
- `sync-worker/src/index.ts` — add block routes, call `verifyToken` on PUT

**Test:** PUT block with valid token → 201; GET same cid → same bytes; GET unknown cid → 404; PUT without token → 401.

---

## S4 — Clock head (meta) + ETag guard

**Outcome:** `PUT/GET /sync/{roomId}/meta` stores/retrieves the CRDT clock head JSON. PUT enforces `If-Match` ETag to prevent blind overwrites.

**Files touched:**
- `sync-worker/src/meta.ts` — `getMeta`, `putMeta` (R2 object with `customMetadata` for ETag)
- `sync-worker/src/index.ts` — add meta routes; return `ETag` header on GET; check `If-Match` on PUT, return 412 on mismatch

**Test:** GET on empty room → 404; PUT → 200 with ETag; GET → same body + ETag; second PUT with wrong ETag → 412; PUT without token → 401.

---

## S5 — Room deletion (revoke)

**Outcome:** `DELETE /sync/{roomId}` removes all R2 keys under `{roomId}/` (token hash, meta, all blocks). Requires valid token.

**Files touched:**
- `sync-worker/src/room.ts` — `deleteRoom(r2, roomId)` — `r2.list({ prefix: roomId + '/' })` + delete all keys
- `sync-worker/src/index.ts` — add `DELETE /sync/{roomId}` route

**Test:** Create room, PUT block, DELETE room → 200; subsequent GET block → 404; GET meta → 404.

---

## S6 — Client service + `useSyncWorker` hook

**Outcome:** Browser can create a sync room, generate a share URL, poll for updates, push changes, and revoke. Merge uses existing `syncShare.ts` helpers.

**Files touched:**
- `news-feed/src/services/syncWorker.ts` (new):
  - `SYNC_STORAGE_KEY = 'BOOMERANG_SYNC'`
  - `createSyncRoom(workerUrl)` → POST `/sync/room`, persist to localStorage
  - `buildSyncUrl(roomId, token)` → `${origin}${pathname}#sync-room=${roomId}:${token}`
  - `parseSyncFragment()` → extract from `location.hash`
  - `loadSyncRoom()` → from localStorage
  - `pushMeta(workerUrl, roomId, token, payload, etag?)` → PUT with `If-Match`; on 412 re-fetch + merge + retry once
  - `fetchMeta(workerUrl, roomId)` → GET, returns `{ payload, etag }`
  - `deleteRoom(workerUrl, roomId, token)` → DELETE
- `news-feed/src/hooks/useSyncWorker.ts` (new):
  - Accepts `{ prefs, articleTags, savedArticles, workerUrl }`
  - On mount: check fragment → save to localStorage → `replaceState`; or load from localStorage
  - Poll `fetchMeta` every 30 s + on `visibilitychange`
  - On new remote payload: call `mergePrefs`, `mergeArticleTags`, `mergeLabelHits` from `syncShare.ts`; emit merged state via callback
  - On prop change (debounced 2 s): `pushMeta`
  - Returns `{ syncActive, syncedAt, syncError, revoke, generateLink }`
- `news-feed/src/services/syncWorker.node.test.ts` (new): unit tests for `parseSyncFragment`, `buildSyncUrl`, merge round-trip

**Environment:** `VITE_SYNC_WORKER_URL` build-time env var (same pattern as `VITE_RSS_WORKER_URL`).

---

## S7 — Settings UI

**Outcome:** Settings shows "Sync across devices" section with generate/copy/QR/revoke controls and live sync status.

**Files touched:**
- `news-feed/src/components/Settings.tsx` — replace current QR/copy-URL section:
  - Inactive state: "Sync across devices" heading + "Generate link" button
  - Active state: "Synced N minutes ago" (or "Syncing…" / error) + copy-link button + QR + "Revoke" button
- `news-feed/src/App.tsx` — wire `useSyncWorker` hook; pass `syncActive`, `syncedAt`, `generateLink`, `revoke` to Settings
- `news-feed/src/App.css` — `.sync-status`, `.sync-actions` styles (minimal, reuse existing `.sync-url-row` / `.sync-qr-wrap`)

**Test:** Manual — generate link, open in second tab, verify state appears.

---

## S8 — Legacy hash fallback cleanup

**Outcome:** `parseSyncHash` still runs on startup for anyone with an old `#sync=` URL. The "generate hash link" UI is removed from Settings. `buildSyncShareUrl` is kept but unexported from the public surface.

**Files touched:**
- `news-feed/src/services/syncShare.ts` — no logic changes; `buildSyncShareUrl` kept but no longer called from UI
- `news-feed/src/components/Settings.tsx` — remove `labelsShareUrl` prop / QR for hash links (replaced by S7 UI)
- `news-feed/src/App.tsx` — remove `labelsShareUrl` from Settings props; keep `parseSyncHash` call in `useFeed`
- `docs/ucan-sync-worker/tdd-log.md` — mark all slices done

---

## Environment & deployment notes

```bash
# Create R2 bucket (once, run from repo root)
cd sync-worker && npx wrangler r2 bucket create boomerang-sync

# Local dev (R2 uses local filesystem in dev mode)
npx wrangler dev

# Deploy
npx wrangler deploy
```

`VITE_SYNC_WORKER_URL` must be added as a GitHub Actions repository variable alongside `VITE_RSS_WORKER_URL`.

The `sync-worker/` root should be added to `.github/workflows/deploy.yml` as an optional deploy step (manual trigger or on push to main, separate from the news-feed Pages deploy).
