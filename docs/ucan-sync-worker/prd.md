# PRD — UCAN Sync Worker

**Feature slug:** `ucan-sync-worker`  
**Branch:** new branch from `main` after `ai-topic-labels` merges  
**Date:** 2026-04-29  
**Status:** Draft

---

## Problem

Boomerang users who open the app on a second browser or device start from scratch: no saved articles, no labels, no topic weights. The current `#sync=` URL-hash approach (`syncShare.ts`) is a one-shot manual copy — it does not stay in sync as either side changes, hits URL length limits as data grows, and requires the user to manually regenerate and reshare the link every time.

Users need a way to keep two or more browsers continuously in sync with zero account creation and minimal friction.

---

## Solution

A new **`sync-worker`** Cloudflare Worker that acts as an encrypted relay and storage layer for Fireproof database blocks, authorised via **UCAN delegation tokens**. The only user-visible action is tapping **"Share sync link"** in Settings — this generates a URL the user opens on their second device. After that, sync happens automatically in the background with no further user interaction.

No accounts. No email. No passwords. The user never sees a cryptographic key or a token.

---

## User Stories

1. **As a user**, I tap "Share sync link" in Settings and receive a URL (or QR code). When I open that URL on my second browser, my prefs, labels, saved articles, and AI tags appear within a few seconds — without creating an account.

2. **As a user**, changes I make on either device (saving an article, adding a label, adjusting topic weights) are reflected on the other device the next time it loads or within ~30 seconds while the app is open.

3. **As a user**, if I share the link with myself via clipboard, iMessage, or email, it works in any modern browser without installing anything extra.

4. **As a user**, I can revoke sync (break the link between devices) from Settings, after which neither device receives updates from the other.

5. **As a developer/operator**, the worker runs alongside `boomerang-rss` on the same Cloudflare account, uses R2 for block storage (free tier: 10 GB / 1M writes / 10M reads per month), and requires no paid Cloudflare plan features.

---

## Current state (what exists today)

- `news-feed/src/services/syncShare.ts` — one-shot URL-hash sync: `buildSyncShareUrl` encodes a `SyncPayloadV1` blob; `parseSyncHash` consumes it once on startup.
- `news-feed/src/hooks/useFeed.ts` — calls `parseSyncHash` on mount, merges with existing Fireproof docs using `mergePrefs`, `mergeArticleTags`, `mergeLabelHits`.
- `rss-worker/` — Cloudflare Worker (Wrangler 4, no KV/R2/DO bindings). Pattern to follow for the new worker.
- `use-fireproof ^0.24` — local-first Fireproof DB; `@fireproof/core-gateways-cloud` is a transitive dep but its hosted endpoint is undocumented/unpriced.

---

## Out of scope (first ship)

- Multi-user / collaborative editing (this is single-user across personal devices only).
- Server-side merge logic — the worker is a dumb block store; CRDT merge happens in the browser.
- Mobile native app support.
- Revocation infrastructure beyond "clear sync data" in Settings.
- End-to-end encrypted content beyond what Fireproof already provides (blocks are opaque to the worker).
- Replacing or removing `syncShare.ts` hash import — keep as legacy fallback for one version.

---

## Architecture

### sync-worker (new, `sync-worker/`)

```
Cloudflare Worker (Wrangler, TypeScript)
  ├── R2 bucket: SYNC_BLOCKS
  │     ├── {roomId}/blocks/{cid}   ← encrypted Fireproof CAR blocks
  │     └── {roomId}/meta           ← CRDT clock head (JSON)
  └── Routes:
        GET  /sync/{roomId}/meta              → clock head JSON
        PUT  /sync/{roomId}/meta              → update clock head, return 200
        GET  /sync/{roomId}/blocks/{cid}      → CAR block bytes (or 404)
        PUT  /sync/{roomId}/blocks/{cid}      → store CAR block bytes
        POST /sync/room                       → create new roomId, return { roomId }
        GET  /sync/{roomId}/invite            → UCAN delegation token for this room
```

No Durable Objects. No WebSockets. HTTP polling only — client polls `/meta` every 30 s and on page focus.

### UCAN auth model (simplified for v1)

- On first "Share sync link", the client generates a **room keypair** (Ed25519 via `@noble/ed25519` or Web Crypto API) and a **roomId** (random 16-byte hex).
- The **room private key** is embedded in the share URL fragment (`#room=<base64-private-key>`) — never sent to the server. The worker only sees the roomId.
- The worker uses the roomId as a namespace in R2. Any client that knows the roomId + private key can read/write.
- UCAN token signs each request: `PUT /sync/{roomId}/meta` includes `Authorization: Bearer <ucan-jwt>` signed by the room key. The worker verifies the signature against the roomId's public key (stored on first `POST /sync/room`).
- This is a **simplified UCAN subset** — single-level delegation (no chain), capability scoped to one room, expiry optional. Full UCAN chain delegation deferred to v2.

### Client changes (news-feed)

- New `useSyncWorker` hook:
  - On mount: if `SYNC_ROOM_KEY` in localStorage, start polling `/sync/{roomId}/meta` every 30 s.
  - On new data: merge via existing `mergePrefs`, `mergeArticleTags` etc., write back to Fireproof.
  - On local change: debounced push to `/sync/{roomId}/meta` + any new blocks.
- Settings UI: replaces the current QR/copy-URL section with:
  - "Sync across devices" → **"Generate link"** button → shows URL + QR + "Revoke" button.
  - If already synced: shows "Synced X minutes ago" status + "Revoke" button.
- `syncShare.ts` hash import kept as read-once fallback (no UI to generate new hash links).

---

## Implementation decisions

| Decision | Choice | Rationale |
|---|---|---|
| Storage | Cloudflare R2 | Free tier covers personal use; no DO/paid plan needed |
| Auth | Simplified UCAN (room keypair in URL fragment) | No accounts; key never leaves client or URL fragment; server verifiable |
| Sync model | HTTP polling (30 s + on focus) | No WebSockets = no DO; acceptable lag for a news app |
| Block format | Fireproof native CAR blocks | Reuses Fireproof's own encrypted format; worker is content-agnostic |
| Crypto library | Web Crypto API (built into browsers + CF Workers) | Zero extra bundle size |
| Full UCAN chain | Deferred to v2 | Adds complexity without user-visible benefit for single-user case |
| Legacy hash sync | Keep as fallback | Zero regression for existing users |

---

## Testing strategy

- **Worker unit tests** (Vitest + `@cloudflare/vitest-pool-workers`): route handling, R2 read/write, UCAN signature verification.
- **Client unit tests** (existing Vitest): `useSyncWorker` hook merge logic, URL fragment key extraction.
- **Manual integration test**: two browser tabs, generate link in tab A, open in tab B, add label in A, verify appears in B within 30 s.

---

## Risks

| Risk | Mitigation |
|---|---|
| R2 free tier quota exceeded | Log R2 operation counts; add block deduplication (skip PUT if CID already exists) |
| Room key in URL fragment indexed by browser history | Document that "Revoke" clears the key; consider expiring room keys |
| Polling adds background network load | Only poll when tab is visible (`document.visibilityState`); back off on errors |
| Fireproof 0.24 block format changes | Worker is format-agnostic (opaque bytes); only meta polling touches JSON |
| CF R2 CORS for cross-origin requests | Worker proxies all R2 access — browser never hits R2 directly |

---

## Milestones

| Slice | Description |
|---|---|
| S1 | `sync-worker` scaffold: Wrangler config, R2 binding, health route, CORS |
| S2 | Block storage routes: PUT/GET `/sync/{roomId}/blocks/{cid}` |
| S3 | Clock head routes: PUT/GET `/sync/{roomId}/meta` |
| S4 | UCAN auth: room keypair, signature on PUT, verification in worker |
| S5 | `useSyncWorker` hook: polling, merge, push on change |
| S6 | Settings UI: generate link, QR, revoke, sync status |
| S7 | Legacy hash fallback: keep `parseSyncHash`, hide "generate hash" UI |

---

## References

- [UCAN spec](https://ucan.xyz/specification/)
- [Fireproof connect repo](https://github.com/fireproof-storage/connect) — PartyKit server as protocol reference
- Existing: `rss-worker/` (Wrangler pattern), `syncShare.ts` (merge helpers), `useFeed.ts` (Fireproof usage)
