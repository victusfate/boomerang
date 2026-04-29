# PRD — Sync Worker

**Feature slug:** `ucan-sync-worker`  
**Branch:** new branch from `main` after `ai-topic-labels` merges  
**Date:** 2026-04-29  
**Status:** Draft (revised — R2 direct storage, token auth)

---

## Problem

Boomerang users who open the app on a second browser or device start from scratch: no saved articles, no labels, no topic weights. The current `#sync=` URL-hash approach (`syncShare.ts`) is a one-shot manual copy — it does not stay in sync as either side changes, hits URL length limits as data grows, and requires the user to manually regenerate and reshare the link every time.

Users need a way to keep two or more browsers continuously in sync with zero account creation and minimal friction.

---

## Solution

A new **`sync-worker`** Cloudflare Worker that acts as a dumb block-store and clock-head relay backed by **Cloudflare R2**. The only user-visible action is tapping **"Share sync link"** in Settings — this generates a URL the user opens on their second device. After that, sync happens automatically in the background with no further user interaction.

No accounts. No email. No passwords. No crypto visible to the user. The share URL fragment contains the room token — whoever has the URL can sync.

---

## User Stories

1. **As a user**, I tap "Share sync link" in Settings and receive a URL (or QR code). When I open that URL on a second browser, my prefs, labels, saved articles, and AI tags appear within a few seconds — without creating an account.

2. **As a user**, changes I make on either device (saving an article, adding a label, adjusting topic weights) are reflected on the other device the next time it loads or within ~30 seconds while the app is open.

3. **As a user**, if I share the link with myself via clipboard, iMessage, or email, it works in any modern browser without installing anything extra.

4. **As a user**, I can revoke sync from Settings. Revocation clears the room token from localStorage on this device; the link no longer works on any device that follows it.

5. **As a developer/operator**, the worker runs alongside `boomerang-rss` on the same Cloudflare free-tier account. R2 storage (10 GB / 1M writes / 10M reads per month free) covers personal use with no paid plan required.

---

## Current state (what exists today)

- `news-feed/src/services/syncShare.ts` — one-shot URL-hash sync: `buildSyncShareUrl` encodes a `SyncPayloadV1` blob; `parseSyncHash` consumes it once on startup. Merge helpers (`mergePrefs`, `mergeArticleTags`, `mergeLabelHits`) are clean CRDT-friendly unions — reusable as-is.
- `news-feed/src/hooks/useFeed.ts` — calls `parseSyncHash` on mount, merges via the helpers above, writes back to Fireproof.
- `rss-worker/` — Cloudflare Worker (Wrangler 4, `wrangler.jsonc`, TypeScript, no bindings). Direct pattern to follow for the new worker.

---

## Out of scope (first ship)

- Multi-user / collaborative editing (single-user across personal devices only).
- Server-side merge logic — the worker is a dumb byte store; CRDT merge happens in the browser.
- Mobile native app support.
- End-to-end encryption beyond what Fireproof already provides (blocks are opaque bytes to the worker).
- Replacing or removing `syncShare.ts` hash import — keep as legacy fallback.
- WebSocket / real-time push — polling is sufficient for a news app.

---

## Architecture

### sync-worker (`sync-worker/`, new)

```
Cloudflare Worker (Wrangler 4, TypeScript)
  └── R2 bucket: SYNC_BLOCKS (free tier)
        {roomId}/meta              ← CRDT clock head JSON (small, ~1 KB)
        {roomId}/blocks/{cid}      ← Fireproof CAR block bytes (opaque)

Routes (all require Authorization: Bearer <token>  for writes):
  POST /sync/room                        → generate roomId + token, store token hash in R2, return { roomId, token }
  GET  /sync/{roomId}/meta               → return clock head bytes (public read)
  PUT  /sync/{roomId}/meta               → overwrite clock head (auth required)
  GET  /sync/{roomId}/blocks/{cid}       → return block bytes, 404 if missing (public read)
  PUT  /sync/{roomId}/blocks/{cid}       → store block bytes (auth required)
  DELETE /sync/{roomId}                  → delete all room data (auth required, used by Revoke)
  GET  /health                           → { ok: true }
```

**Auth:** `POST /sync/room` generates a cryptographically random 32-byte `token` and stores `SHA-256(token)` at `{roomId}/.token` in R2. Write requests present `Authorization: Bearer <token>`; the worker hashes it and compares to the stored hash. Reads are public (the roomId itself is a 256-bit secret embedded only in the URL fragment — not in any server log).

**No Durable Objects. No KV. No paid plan features.**

### Client changes (`news-feed/`)

**New service: `syncWorker.ts`**
- `createSyncRoom(workerUrl)` → POST `/sync/room`, persist `{ roomId, token }` to localStorage as `BOOMERANG_SYNC`.
- `buildSyncUrl(roomId, token)` → `${origin}${pathname}#sync-room=${roomId}:${token}` (fragment only — never logged by server).
- `parseSyncRoom()` → extract `{ roomId, token }` from `location.hash` or localStorage.
- `pushMeta(roomId, token, payload)` → PUT `/sync/{roomId}/meta`.
- `fetchMeta(roomId)` → GET `/sync/{roomId}/meta`.

**New hook: `useSyncWorker(prefs, articleTags, savedArticles)`**
- On mount: if `BOOMERANG_SYNC` in localStorage or `#sync-room=` in URL, activate sync.
- On URL fragment: extract roomId+token, save to localStorage, `replaceState` to clean URL.
- Poll `fetchMeta` every 30 s and on `visibilitychange` to `visible`.
- On new remote meta: merge via `mergePrefs`, `mergeArticleTags`, `mergeLabelHits` from `syncShare.ts`.
- On local change (debounced 2 s): `pushMeta` with current state.
- Exposes `{ syncStatus, syncedAt, revoke }`.

**Settings UI changes**
- Replace current QR/copy-URL section with:
  - Inactive: **"Sync across devices"** → "Generate link" button.
  - Active: "Synced {N} minutes ago" + copy-link icon + QR + "Revoke" button.

---

## Implementation decisions

| Decision | Choice | Rationale |
|---|---|---|
| Storage | Cloudflare R2 | Free tier, same CF account as rss-worker, no third-party dependency |
| Auth on writes | SHA-256 token hash stored in R2 | Zero crypto libraries; Web Crypto available in both CF Workers and browser |
| Reads | Public (roomId is the secret) | Simplifies read path; roomId is 256-bit random, URL-fragment only |
| Sync model | HTTP polling (30 s + on focus) | No DO/WebSockets; acceptable lag for a news app |
| Block format | Opaque bytes | Worker is content-agnostic; Fireproof handles encryption |
| Merge logic | Reuse `syncShare.ts` helpers | Already written, tested, CRDT-correct |
| Legacy `#sync=` hash | Keep `parseSyncHash`, remove generate UI | Zero regression for existing hash links |
| UCAN / crypto chain | Out of scope v1 | Token-in-fragment achieves same UX without the complexity |

---

## Testing strategy

- **Worker tests** (Vitest + `@cloudflare/vitest-pool-workers` or miniflare): route auth, R2 read/write, room creation, token hash verification, CORS headers.
- **Client tests** (existing Vitest): `parseSyncRoom`, `buildSyncUrl`, merge logic via existing `syncShare` tests.
- **Manual integration**: two tabs, generate link in tab A, open in tab B, mutate state in A, verify appears in B ≤ 30 s.

---

## Risks

| Risk | Mitigation |
|---|---|
| R2 free quota exceeded at scale | Deduplicate blocks (skip PUT if CID key exists in R2); log op counts |
| Room token in browser history (if URL bar shows fragment) | Fragment never sent to server; "Revoke" deletes room from R2 + clears localStorage |
| Polling drains battery on mobile | Only poll when `document.visibilityState === 'visible'`; exponential backoff on errors |
| Stale clock head overwrites newer state | PUT meta includes `If-Match` etag; worker returns 412 on conflict, client re-fetches and re-merges |
| Worker CORS blocks GitHub Pages origin | Extend `isAllowedOrigin` pattern from `rss-worker` |

---

## Milestones

| Slice | Description |
|---|---|
| S1 | `sync-worker/` scaffold: `wrangler.jsonc` with R2 binding, health route, CORS (mirrors `rss-worker` pattern) |
| S2 | Room creation: `POST /sync/room` — generate roomId + token, store token hash in R2 |
| S3 | Block storage: `PUT/GET /sync/{roomId}/blocks/{cid}` with auth on PUT |
| S4 | Clock head: `PUT/GET /sync/{roomId}/meta` with auth on PUT + ETag conflict guard |
| S5 | Room deletion: `DELETE /sync/{roomId}` (revoke) |
| S6 | `syncWorker.ts` client service + `useSyncWorker` hook (polling, merge, push) |
| S7 | Settings UI: generate link, QR, sync status, revoke |
| S8 | Legacy: hide "generate hash link" UI, keep `parseSyncHash` read path |

---

## References

- `rss-worker/` — Wrangler 4 pattern, CORS helpers to extend
- `news-feed/src/services/syncShare.ts` — merge helpers, `SyncPayloadV1` type
- [Cloudflare R2 docs](https://developers.cloudflare.com/r2/)
- [Cloudflare R2 free tier](https://developers.cloudflare.com/r2/pricing/)
