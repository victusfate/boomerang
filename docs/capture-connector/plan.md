# Implementation Plan: Capture Connector

Vertical slices. Each cuts data → logic → (UI where relevant) → tests, is
independently testable, and leaves the tree green. TDD per slice:
RED → GREEN → REFACTOR.

**Scope note (revised):** Server-side email delivery (Resend) is dropped.
Email sharing is a dependency-free client-side `mailto:` action (Slice 7).
Server destinations are `saved-list` and `github` only.

---

## Slice 1 — Token lifecycle

**Server.** Generate / rotate / revoke a capture token with a KV forward record
and a reverse index, authenticated against the room bearer token.

- `platform-worker/src/domains/capture/token.ts`
  - `CaptureTokenRecord`, `CaptureDestination` types
  - `generateCaptureToken(kv, roomId, destination)` → rotates: deletes any
    existing token (via reverse index `capture-room:{roomId}`), writes new
    `capture-token:{tokenId}` + reverse index, returns `{ captureToken }`
  - `revokeCaptureToken(kv, roomId)` → deletes both keys
  - `resolveCaptureToken(kv, tokenId)` → `CaptureTokenRecord | null`
  - reuse `randomBase64Url` from `sync/room.ts` (32 bytes)
- Tests `token.node.test.ts`: generate produces valid base64url; rotate deletes
  prior forward key; revoke deletes forward + reverse; resolve returns record.

**Behaviors to test:** generate writes both keys; rotate removes old forward
key; revoke removes both; resolve of unknown id → null.

---

## Slice 2 — Ingest gate (token → rate limit → validate → 204)

**Server.** The ingest endpoint up to (but excluding) dedupe and destination
dispatch. Unknown token → 401; over rate limit → 429; bad body/url → 400;
otherwise 204 with CORS header.

- `platform-worker/src/domains/capture/normalize.ts`
  - `normalizeBody(raw: string): CaptureRecord | null` — JSON parse, url is
    http/https, title/note trimmed, note capped 8192 bytes, server `ts`+`id`.
- `platform-worker/src/domains/capture/rateLimit.ts`
  - `checkCaptureRateLimit(kv, tokenId)` — KV `capture-rl:{tokenId}`, 60/hr
    window; returns `{ limited, retryAfterSeconds }`.
- `platform-worker/src/domains/capture/index.ts`
  - `handleCapture(request, env, ctx)` routing `/api/capture/*`
  - ingest path: resolve token → rate limit → normalize → 204 (CORS `*`).
    (dedupe + dispatch arrive in slices 3–4.)
- Tests: `normalize.node.test.ts`, `rateLimit.node.test.ts`.

**Behaviors to test:** valid body → CaptureRecord with server ts/id; non-http
url → null; note over cap truncated; client ts ignored. Rate limit: 1st passes,
61st limited, window reset re-allows. Ingest: unknown token 401, invalid url
400, over-limit 429, happy path 204.

---

## Slice 3 — Dedupe

**Server.** 5-minute URL dedupe folded into ingest: a repeat URL within the
window is a silent 204 drop (no dispatch, no error).

- `platform-worker/src/domains/capture/dedupe.ts`
  - `isDuplicate(kv, tokenId, url)` — checks `capture-dedup:{tokenId}:{sha256(url)}`
  - `markSeen(kv, tokenId, url)` — writes key with 300 s TTL
  - reuse `sha256Hex` from `sync/auth.ts`
- Wire into `index.ts` between validate and dispatch.
- Tests `dedupe.node.test.ts`: first url passes; second within window dropped;
  key TTL is 300 s; different urls independent.

**Behaviors to test:** first → not duplicate; mark then check → duplicate; TTL
value passed to put; ingest returns 204 and skips dispatch on duplicate.

---

## Slice 4 — saved-list adapter

**Server.** `saved-list` destination: read `{roomId}/meta` from R2, prepend a
capture `Article` + `prefs.savedIds`, conditional write; retry once on 412.

- `platform-worker/src/domains/capture/adapter/savedList.ts`
  - `appendToSavedList(r2, roomId, capture)` — get meta + etag, build Article,
    prepend id to `savedIds`, set `savedAtById`, `put` with
    `onlyIf:{etagMatches}`; on null (412) re-fetch + retry once, then drop.
- Wire into `index.ts`: `saved-list` dispatched synchronously before 204.
- Tests `savedList.node.test.ts`: appends article + savedId; conditional put
  uses etag; retries once on 412 then succeeds; drops after second conflict.

**Behaviors to test:** article fields mapped per PRD; savedIds prepended;
etag passed to onlyIf; 412 once → re-read + succeed; 412 twice → no throw, drop.

---

## Slice 5 — github adapter

**Server.** `github` destination: GitHub Contents API read → append checklist
entry → commit; retry once on SHA conflict. Dispatched via `ctx.waitUntil`.

- `platform-worker/src/domains/capture/adapter/github.ts`
  - `appendToGithub(fetchFn, pat, config, capture)` — GET contents, decode,
    append `- [ ] {title} — {url}  <!-- note: {note} | ts: {ts} -->`, PUT with
    sha+branch; on 409 re-fetch + retry once. `fetchFn` injected for testing.
- Wire into `index.ts`: `github` dispatched via `ctx.waitUntil`.
- Tests `github.node.test.ts`: correct GET url; entry format; PUT payload
  (base64 content, sha, branch, message); 409 → retry once.

**Behaviors to test:** entry string exact; base64 round-trip; PUT body shape;
conflict retry path.

---

## Slice 6 — Settings UI (CaptureSection + token hook + wiring)

**News-feed.** Destination picker (saved-list / github), generate & regenerate
token, render the bookmarklet `javascript:` snippet, revoke. Token in
localStorage (not synced); `captureDestination` added to `UserPrefs` (synced).

- `news-feed/src/hooks/useCaptureToken.ts` — localStorage `BOOMERANG_CAPTURE`,
  generate/revoke calling worker endpoints, expose `{ captureToken, generate,
  revoke }` and derived bookmarklet URL.
- `news-feed/src/components/settings/CaptureSection.tsx` — mirrors
  `SyncSection.tsx`.
- `UserPrefs.captureDestination?: CaptureDestination` in `types.ts`.
- `Settings.tsx` + `App.tsx` wiring.
- `apiRoutes.ts` doc entries; `env.ts` `CAPTURE_TOKENS` + `GITHUB_PAT`;
  `wrangler.jsonc` KV binding; register `handleCapture` in worker `index.ts`.
- Tests: bookmarklet URL builder unit test; `buildBookmarklet.node.test.ts`
  (pure fn extracted so it is testable without a DOM).

**Behaviors to test:** bookmarklet URL embeds worker URL + token; regenerate
swaps token; absent token → no bookmarklet.

---

## Slice 7 — Client-side email share (`mailto:`)

**News-feed.** Pure `buildMailto` + an "Email" action over selected captures.
Dependency-free; replaces the dropped server email adapter.

- `news-feed/src/services/buildMailto.ts`
  - `buildMailto(items: { title: string; url: string }[]): string`
- Hook the action into the saved/captures view (single + multi select).
- Tests `buildMailto.node.test.ts`: single item; multiple batched into body;
  special-character URL-encoding of title/url; empty list → `mailto:` with
  empty body.

**Behaviors to test:** subject/body encoding; one line per item; ampersands /
spaces / unicode encoded correctly.

---

## Slice 8 — Smoke / integration script

**Server.** End-to-end against a running local worker.

- `platform-worker/scripts/capture-smoke-test.mjs` — generate token (200),
  capture (204), duplicate (204), 61 → 429, unknown token (401), invalid url
  (400), revoke (204) then capture (401). Gate on `RUN_INTEGRATION`.

**Behaviors to test:** full caller workflow against real worker; matches
existing `integration-test.mjs` output format.

---

## Sequencing notes

- Slices 1–5 are pure server logic, fully unit-testable with mock KV/R2/fetch.
- Slice 6 is the only DOM-touching slice; extract pure builders so logic stays
  unit-testable.
- Slice 7 is independent of the bookmarklet path and could ship alone.
- Slice 8 requires `wrangler dev`; gated, run manually.
- Each slice ends green and committed before the next begins.
