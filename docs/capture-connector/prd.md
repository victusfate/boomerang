# PRD: Capture Connector

## Problem Statement

A boomerang user reading an article in any browser has no quick way to save
it to their boomerang reading list or route it to an external destination
(email inbox, GitHub file). Opening boomerang, finding the article, and saving
it manually breaks flow. There is no bookmarklet or one-click capture today.

## Solution

A bookmarklet that sends the current page to boomerang with a single click.
The user drags the bookmarklet to their browser's bookmark bar once. On any
page they want to save, they click it. The page is POSTed to boomerang, which
routes it to a configured destination: the user's boomerang saved list or a
Markdown file in a GitHub repo.

Email is intentionally **not** a server-side destination in v1 — it would
require a third-party transactional-email dependency (Resend) plus a verified
sender domain. Instead, sharing captures by email is a dependency-free,
client-side action: the user selects one or more saved captures and clicks
"Email", which opens their default mail client (`mailto:`) pre-filled with the
titles and URLs. No secrets, no server, no external service.

The capture token embedded in the bookmarklet is write-only and revocable. A
leak cannot read the user's data; it can only spam captures. The user can
regenerate the token (and the bookmarklet) at any time from settings.

## User Stories

1. As a reader, I want to click a bookmarklet on any page and have it saved
   to my boomerang reading list, so I can find it later in my feed.
2. As a reader, I want to select one or more saved captures and click "Email"
   to open my default mail client pre-filled with their titles and URLs, so I
   can forward them without any server-side email setup.
3. As a reader, I want to configure a GitHub repo and file path as my capture
   destination, so captures are appended as Markdown checklist entries.
4. As a reader, I want to drag a generated bookmarklet snippet to my bookmark
   bar, so the same bookmark works on every browser without logging in.
5. As a reader, I want to regenerate my bookmarklet from settings, so a
   compromised token can be revoked immediately without affecting my sync link.
6. As a reader, I want the bookmarklet to show a brief on-screen confirmation
   after clicking, so I know the capture was queued.
7. As a reader, I want duplicate captures of the same URL (e.g. a double-click)
   to be silently dropped within a 5-minute window, so I do not get duplicates.
8. As a reader, I want the bookmarklet to capture any text I have selected as a
   note alongside the URL and title, so I can preserve context.

## Implementation Decisions

### New domain: `platform-worker/src/domains/capture/`

All server-side capture logic lives here. Structure:

- `index.ts` — request router; exports `handleCapture`
- `token.ts` — generate, revoke, rotate token records; verify management-endpoint auth
- `rateLimit.ts` — KV-based 60/hr per-token counter
- `dedupe.ts` — KV TTL key for 5-minute URL dedup
- `normalize.ts` — parse + validate raw POST body into `CaptureRecord`
- `adapter/savedList.ts` — R2 meta read → append → conditional write
- `adapter/github.ts` — GitHub Contents API read → append → commit

`handleCapture` is registered in `platform-worker/src/index.ts` for paths
matching `/api/capture/*`.

### New routes (registered in `apiRoutes.ts`)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/capture/:captureToken` | None (token in path) | Ingest a capture |
| POST | `/api/capture/token` | Bearer (room token) | Generate or rotate capture token |
| DELETE | `/api/capture/token` | Bearer (room token) | Revoke capture token |

### Env additions (`platform-worker/src/env.ts`)

```
CAPTURE_TOKENS: KVNamespace   // new wrangler binding
GITHUB_PAT: string            // Worker secret (fine-grained, contents:write)
```

### Wrangler config (`platform-worker/wrangler.jsonc`)

Add `CAPTURE_TOKENS` KV namespace binding. Bind the existing preview namespace
for local dev (`--local` uses in-memory KV automatically).

### KV schema

| Key | Value | TTL |
|-----|-------|-----|
| `capture-token:{tokenId}` | `CaptureTokenRecord` (discriminated union) | none |
| `capture-rl:{tokenId}` | `{ count: number, windowStart: number }` | none (managed manually) |
| `capture-dedup:{tokenId}:{sha256(url)}` | `""` (empty) | 300 s |

All three key prefixes share the `CAPTURE_TOKENS` KV namespace.

### CaptureTokenRecord (discriminated union, stored as JSON)

```typescript
type CaptureTokenRecord =
  | { roomId: string; destinationType: 'saved-list' }
  | { roomId: string; destinationType: 'github'; destinationConfig: {
        owner: string; repo: string; path: string; branch: string;
      }};
```

### CaptureRecord (normalized; passed to adapters)

```typescript
interface CaptureRecord {
  id:     string;   // 16-byte base64url, server-generated (reuse randomBase64Url from sync/room.ts)
  url:    string;   // validated http/https
  title:  string;   // trimmed, default ""
  note:   string;   // trimmed, capped at 8 192 bytes
  ts:     string;   // server receive time ISO-8601 (client ts ignored)
  source: string;   // e.g. "bookmarklet"
}
```

### Capture ingest flow (`POST /api/capture/:captureToken`)

1. Resolve token from KV → 401 if missing
2. KV rate-limit check (60/hr) → 429 if exceeded
3. Parse body as JSON (body is `text/plain`, body size cap 16 KB) → 400 if invalid
4. Validate `url` is `http://` or `https://` → 400 if not
5. KV dedupe check (`capture-dedup` key) → 204 silent drop if present
6. Write dedupe key (300 s TTL) and increment rate-limit counter
7. For `saved-list`: dispatch synchronously (R2 read → append → conditional write)
8. For `github`: dispatch via `ctx.waitUntil` (async, best-effort)
9. Respond `204 No Content` with `Access-Control-Allow-Origin: *`

### saved-list adapter

The adapter reads `{roomId}/meta` from `SYNC_BLOCKS` R2, parses
`SyncPayloadV1`, and appends the capture as a new `Article` entry:

```typescript
{
  id:          capture.id,
  title:       capture.title || capture.url,
  url:         capture.url,
  description: capture.note || '',
  publishedAt: new Date(capture.ts),
  source:      'Capture',
  sourceId:    'capture',
  topics:      ['general'],
}
```

`prefs.savedIds` is also prepended with the capture id. Write uses
`onlyIf: { etagMatches }` (conditional R2 put). Retries once on 412
(re-fetch + re-append). If the second attempt also conflicts, the capture
is logged and dropped (best-effort; no infinite retry).

### client-side email share (replaces the server email adapter)

No server adapter. A "Email" action in the saved/captures UI builds a `mailto:`
URL from the selected captures and calls `window.location.href = mailtoUrl`,
which opens the user's default mail client. Pure function `buildMailto`:

```typescript
buildMailto(captures: { title: string; url: string }[]): string
// → "mailto:?subject=...&body=..."  (subject + URL-encoded body, one per line)
```

Multiple captures are batched into a single message body. No token, no network,
no secret. Lives in `news-feed` only.

### github adapter

1. GET `https://api.github.com/repos/{owner}/{repo}/contents/{path}?ref={branch}`
2. Decode base64 content, append entry:
   `- [ ] {title} — {url}  <!-- note: {note} | ts: {ts} -->`
3. PUT with `{ message, content: base64(new content), sha, branch }`.
4. On 409 conflict (SHA mismatch): re-fetch and retry once.

### Token management endpoints

`POST /api/capture/token` — generate or rotate:
- Auth: verify room bearer token against `{roomId}/.token` in R2 (reuse `verifyToken` from sync/auth.ts)
- If an existing capture token is found for this roomId, delete it from KV first
- Generate new 32-byte base64url token, write `CaptureTokenRecord` to KV
- Response: `{ captureToken: string }` (200)

`DELETE /api/capture/token` — revoke:
- Auth: same
- Body: `{ roomId: string }`
- Delete `capture-token:{tokenId}` from KV
- Response: 204

Finding an existing token by roomId requires a KV list scan with prefix
`capture-token:` + checking each record's `roomId` field. Since there is at
most one token per room this is bounded; alternatively, store a reverse index
`capture-room:{roomId} → tokenId` in the same namespace.

**Decision:** add reverse index `capture-room:{roomId}` → tokenId. Written on
token creation, deleted on revocation. Avoids full KV list scan.

### News-feed Settings UI

New `CaptureSection.tsx` in `news-feed/src/components/settings/`, following the
pattern of `SyncSection.tsx`.

Props passed down from `App.tsx` via `Settings.tsx`:

```typescript
captureToken: string | null;
captureDestination: CaptureDestination | null;
onGenerateCaptureToken: (destination: CaptureDestination) => Promise<void>;
onRevokeCaptureToken: () => Promise<void>;
```

`CaptureDestination` (stored in `UserPrefs` and synced via room meta):

```typescript
type CaptureDestination =
  | { type: 'saved-list' }
  | { type: 'github'; owner: string; repo: string; path: string; branch: string };
```

The captured `captureToken` itself is stored separately in a new
`useCaptureToken` hook (localStorage only — not synced, since it's
device-agnostic by design). The bookmarklet `javascript:` URL is constructed
client-side from `PLATFORM_WORKER_URL` and the stored token.

`UserPrefs` gains one optional field: `captureDestination?: CaptureDestination`.
This is synced through the existing sync path so destination config is shared
across devices. The token itself is not synced (it is device-portable by
design — one token works everywhere).

### CORS

The `/api/capture/:captureToken` endpoint responds with
`Access-Control-Allow-Origin: *` on all responses. No preflight is needed
because `sendBeacon` with `Blob(text/plain)` is a CORS simple request.

## Testing Decisions

**Framework:** `node:test` + `assert/strict`. Same pattern as
`articleMeta.node.test.ts`. Mock KV and R2 objects passed as `Env`.

**What makes a good test here:**
- Tests must be runnable with `node --test --experimental-strip-types`
- Mock KV: simple `Map`-backed object with `get`, `put`, `delete`, `list`
- Mock R2: `Map`-backed with `get` (returning object with `.text()`, `.etag`),
  `put` (with `onlyIf` support), `head`
- Mock `fetch`: replaceable via dependency injection on adapter functions

**Modules with unit tests:**

1. `normalize.ts` — body parse, url validation, note cap, ts override
2. `rateLimit.ts` — first request passes, 61st request returns 429, window resets
3. `dedupe.ts` — first URL passes, second URL within window is dropped, key
   uses correct TTL
4. `token.ts` — generate produces valid base64url, rotate deletes old key,
   revoke deletes both forward and reverse index keys
5. `adapter/savedList.ts` — appends article + prefs.savedId, retries on 412,
   drops after second conflict
6. `adapter/github.ts` — constructs correct entry, retries on SHA conflict
7. `buildMailto.ts` (news-feed) — single capture, multiple captures, URL-encoding
   of titles/URLs with special characters

**Integration / smoke tests** (`scripts/capture-smoke-test.mjs`):
- POST a capture to a running local worker → expect 204
- POST a duplicate within 5 min → expect 204 (silent drop, not error)
- POST 61 captures → expect 429 on the 61st
- POST with an unknown token → expect 401
- POST with invalid URL → expect 400
- POST /api/capture/token (generate) → expect 200 with captureToken
- DELETE /api/capture/token → expect 204; subsequent capture POST → expect 401

Run with: `node scripts/capture-smoke-test.mjs`

**Prior art:** `scripts/integration-test.mjs` for the pattern.

## Out of Scope

- Browser extension variant
- Per-POST destination override (destination is always user-config only)
- Read-back of user data via capture token
- Multi-tenant GitHub App auth (PAT only in v1)
- Server-side email delivery (Resend / any transactional-email provider).
  Replaced by the dependency-free client-side `mailto:` share.
- Retry queue for failed github deliveries
- Capture history / inbox view in the UI
- Any downstream consumer logic

## Further Notes

- GitHub fine-grained PAT must have `contents:write` on the target repo.
- The reverse index (`capture-room:{roomId}`) must be kept in sync with the
  forward key. If they drift (e.g. a partial write failure), the next rotation
  call re-writes both.
- The `captureToken` in localStorage is not encrypted. Anyone with access to the
  browser's local storage for the boomerang origin can extract it — same
  exposure level as the sync URL token. Consistent with the existing model.
