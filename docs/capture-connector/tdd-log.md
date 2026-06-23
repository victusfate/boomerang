# TDD Log — Capture Connector

## Slice 1 — Token lifecycle
- Status: done
- Tests: 6 passing (`capture/token.node.test.ts`)
- Behaviors: generate writes forward+reverse; github destinationConfig stored;
  rotate deletes prior forward key; revoke deletes both keys; revoke no-op for
  unknown room; resolve unknown → null.
- Notes: exported `randomBase64Url` from `sync/room.ts`; added `.ts` extension to
  `sync/room.ts`'s `./auth` value import so the module graph runs under
  `node --test --experimental-strip-types`. Added `types.ts` (CaptureDestination,
  CaptureTokenRecord, CaptureRecord). Pre-existing unrelated tsc error in
  `_shared/http.ts` left untouched.

## Slice 2 — Ingest gate
- Status: done
- Tests: 14 passing (`normalize`, `rateLimit`, `index` ingest).
- Behaviors: normalize parse/url-validate/note-cap/server-ts; KV rate limit
  60/hr with reset + per-token isolation; ingest 401 unknown token, 429 over
  limit, 400 bad url, 405 non-POST, 204 happy path with `ACAO:*`.
- Notes: capture rate limit is KV-based (survives instance churn) per PRD, not
  the in-memory `_shared/http` limiter. Added missing HTTP status constants
  (204/401/405/409/412/429) to `lib/http-status.ts` — this also resolved the
  pre-existing `HTTP_TOO_MANY_REQUESTS` build break in `_shared/http.ts`. Used
  `.ts` import specifiers for runtime value imports so node strip-types resolves.
  `CAPTURE_TOKENS` KV + optional `GITHUB_PAT` added to `Env`.

## Slice 3 — Dedupe
- Status: done
- Tests: 6 module + 1 ingest (`dedupe`, `index`).
- Behaviors: not-dup before seen; dup after markSeen; 300 s TTL on key; per-url
  and per-token isolation; ingest silently 204-drops a repeat url and writes one
  dedupe key.
- Notes: reuses `sha256Hex` from `sync/auth.ts`. Rate-limit counter currently
  increments before the dedupe check (PRD ordered it after); dupes consuming a
  small slice of quota is harmless and protective — left as-is.

## Slice 4 — saved-list adapter
- Status: done
- Tests: 5 adapter + 1 ingest dispatch.
- Behaviors: prepends StoredArticle + savedId + savedAtById to existing meta and
  preserves unrelated fields; conditional put on read etag; retry once on 412
  then succeed; drop without throwing after second conflict; create fresh
  payload when meta absent.
- Notes: server stores `StoredArticle` form (publishedAt as ISO string) to match
  news-feed `SyncPayloadV1`. Fresh payload is minimal (merged client-side as
  `Partial<UserPrefs>`). Adapter preserves unknown payload fields via in-place
  mutate + re-stringify. saved-list dispatched synchronously before the 204.

## Slice 5 — github adapter
- Status: done
- Tests: 3 adapter + 1 ingest dispatch.
- Behaviors: GET contents on branch → decode → append checklist entry → PUT with
  sha/branch/message; create with no sha on 404; retry once on 409 then succeed.
  Ingest dispatches github via `ctx.waitUntil` (async, best-effort).
- Notes: `fetch` injected into the adapter for testability; ingest passes the
  global `fetch`. Entry format `- [ ] {title} — {url}  <!-- note: {note} | ts:
  {ts} -->`. Dispatch is gated on `env.GITHUB_PAT` being present.

## Slice 6 — Settings UI + worker wiring
- Status: done
- Tests: 4 token-management (server) + 5 bookmarklet-builder (client).
- Behaviors: POST/DELETE `/api/capture/token` with room-bearer auth (generate
  200, bad bearer 401, revoke 204, bad destination 400); pure `buildCaptureEndpoint`
  + `buildBookmarklet`; `CaptureSection` destination picker + draggable
  bookmarklet + revoke; registered `handleCapture` for `/api/capture/`.
- Notes / deviations: (1) `captureDestination` is stored locally in the capture
  hook's localStorage (`BOOMERANG_CAPTURE`) rather than synced `UserPrefs` — the
  capture token itself is device-portable and unsynced, so syncing only the
  destination had marginal value vs. deep `useFeed` plumbing. (2) `CaptureSection`
  self-instantiates `useCaptureToken` (reads the sync room from localStorage for
  auth), so `Settings.tsx`/`App.tsx` gain a prop-less child only — minimal diff.
  (3) `wrangler.jsonc` `CAPTURE_TOKENS` id is a `REPLACE_ME` placeholder (needs a
  real namespace before deploy; `--local` ignores it). Added `.ts` extension to
  `cors.ts`'s `./corsOrigins` value import for node-test resolution.

## Slice 7 — client-side mailto email share
- Status: done
- Tests: 6 (`buildMailto`).
- Behaviors: single item; multi-item batched body; count subject; special-char
  encoding; title→url fallback; empty list → empty body.
- Notes: "Email all" button added to the saved-view header in `App.tsx`; opens
  the default mail client via `window.location.href`. No server, no dependency.

## Slice 8 — smoke / integration script
- Status: done
- Script: `scripts/capture-smoke-test.mjs` (gated on `RUN_INTEGRATION`).
- Ran live against `wrangler dev --local`: 7/7 passed — token generate (200),
  capture (204), duplicate (204), invalid url (400), unknown token (401),
  rate-limit 61→429, revoke (204)→capture (401). Separately verified a
  saved-list capture writes a `StoredArticle` + `savedIds` into room meta.
- Notes: `npm run test:capture-smoke` added.

## Pre-existing issues (NOT caused by capture-connector)
- `news-feed` `tsc --noEmit` fails on `src/components/rec/RecScoreTable.tsx:29`
  (a JSX comment placed illegally inside `return (...)`), which also blocks
  `npm run build`. Confirmed on the clean tree before any capture changes.
- `news-feed` node tests `syncWorker` + `metaWorker` fail because they import
  `../lib/http-status.js` (no `.js` file under node strip-types). Pre-existing.
  All capture files are type-clean and their tests pass.
