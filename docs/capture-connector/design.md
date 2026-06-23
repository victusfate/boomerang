# Capture Connector — Design

## Purpose

Let a user save the page they are on by clicking a bookmarklet. The bookmarklet
opens a small popup to boomerang's `/save` page, which records the page into the
user's saved list. From there the saved list is readable by downstream agents
(e.g. victusama) for tagging and ingest.

---

## Amendments — 2026-06-23

The implementation diverged from the original Q&A below. **This section is the
current source of truth; where it conflicts with the Q&A, this wins.** The Q&A
is kept as the design record of how decisions were originally reached.

- **Destinations reduced to one: `saved-list`.** The `email` (Resend) adapter
  was never built. The `github` adapter was built, then removed (2026-06-23) —
  ad/tracker blockers, PAT management, and a redundant path with the saved list
  made it not worth keeping. `CaptureTokenRecord`, `parseDestination`, and the
  Settings UI now know only `saved-list`. `GITHUB_PAT` / `RESEND_API_KEY` secrets
  are gone. The destination picker is gone.
- **Bookmarklet mechanism: `sendBeacon`/`fetch` → `window.open` popup.** A
  background `sendBeacon`/`fetch` is classified as a tracker beacon and silently
  blocked by Brave Shields and ad blockers. The bookmarklet now opens a small
  popup to `GET /save/:token` — a user-initiated top-level navigation, which
  blockers allow. The popup saves server-side, flashes a confirmation, and
  auto-closes. `POST /api/capture/:token` is retained for the token API and
  programmatic use.
- **`ctx.waitUntil` no longer used.** With email/github gone, the only adapter
  (`saved-list`) writes synchronously to R2 before the response.
- **First-party custom domain.** The worker is served from
  `api.boomerang-news.com` (wrangler `routes` custom domain) instead of
  `*.workers.dev`, which is heavily on filter lists.
- **Downstream consumer.** victusama reads the saved list via
  `GET /sync/{roomId}/meta`. See `victusama-integration.md`.

---

## Q&A — Architecture Decisions

**Q1: Where should capture tokens be stored?**
New KV namespace (`CAPTURE_TOKENS`). One key per token, value is
`{ roomId, destinationType, destinationConfig }`. Fast lookup, native TTL
support, no extra R2 blobs. A new wrangler binding is required.

**Q2: How does a captured page appear in the saved-list adapter?**
The capture token maps to a `roomId`. The backend reads `{roomId}/meta` from
R2, appends the capture as a `savedArticle`, and writes back using the existing
ETag / If-Match optimistic-concurrency pattern. Captured pages appear alongside
feed-saved articles in the reader.

**Q3: Async dispatch — inline or `ctx.waitUntil`?**
`ctx.waitUntil`. The endpoint responds 204 immediately; email and GitHub
delivery runs after the response is sent. Best-effort: if the Worker is killed
mid-delivery the capture is lost, which matches the fire-and-forget nature of
`sendBeacon`. The saved-list adapter writes synchronously (it only touches R2).

**Q4: Email provider?**
Resend. Fetch-based REST API, native Cloudflare Workers support, 3 000
emails/month free tier. API key stored as `RESEND_API_KEY` Worker secret.

**Q5: GitHub adapter auth?**
Fine-grained PAT scoped to the target repo (`contents:write`), stored as a
`GITHUB_PAT` Worker secret. Self-hosted single-user assumption. No GitHub App
infrastructure required.

**Q6: Dedupe mechanism?**
KV with a 5-minute TTL key: `capture-dedup:{tokenId}:{sha256(url)}`. Written on
every accepted capture. Reliable across Cloudflare isolates. If the key already
exists the capture is silently dropped and 204 is returned.

**Q7: Rate limiting?**
KV-based, globally consistent. Key: `capture-rl:{tokenId}`, value:
`{ count, windowStart }`. Default limit: 60 captures/hour/token. Returns 429 on
exceed. KV is read on every capture; the counter is incremented atomically via
read-modify-write (acceptable at this scale).

---

## Security Model

Reuses boomerang's existing auth-by-possession model.

- **Capture token** — opaque random 32-byte base64url string. Capability scope:
  `capture:create` only. Write-only. Possessing it cannot read the user's feed,
  saved articles, or sync data.
- **Sync URL token is never reused** in the bookmarklet.
- **Leak blast radius** — write-only spam into one user's destination. No read,
  no account takeover (no accounts exist).
- **Mitigations** — revocation (regenerate token), rate limiting (KV-based 60/hr),
  dedupe (KV 5-min window). HMAC signing and OAuth are excluded (key is as
  exposable as a bearer token; bookmarklet cannot do an OAuth dance silently).

---

## Capture Token Record (KV)

Namespace: `CAPTURE_TOKENS` (new wrangler binding). Dedupe and rate-limit
counters also live in this namespace under distinct key prefixes.

```
Key:   capture-token:{tokenId}
Value: CaptureTokenRecord (discriminated union on destinationType)
```

Token format: 32 bytes, base64url, no padding. Generated server-side.

```typescript
// Single destination as of 2026-06-23 (see Amendments). Zero additional config —
// the adapter writes to the room's own savedArticles[].
type CaptureTokenRecord = { roomId: string; destinationType: 'saved-list' };
```

### KV key prefixes in CAPTURE_TOKENS

| Prefix | Purpose |
|--------|---------|
| `capture-token:{tokenId}` | Token record (roomId + destination config) |
| `capture-rl:{tokenId}` | Rate-limit counter `{ count, windowStart }` |
| `capture-dedup:{tokenId}:{urlHash}` | Dedupe sentinel (5-min TTL, no value needed) |

### Capture record (passed to adapters)

Server-generated `id` is a random 16-byte base64url string (same
`randomBase64Url` helper used by sync room token).

```typescript
interface CaptureRecord {
  id:     string;   // server-generated, 16-byte base64url
  url:    string;
  title:  string;
  note:   string;   // capped at 8 KB server-side
  ts:     string;   // server receive time (ISO-8601), overrides client ts
  source: string;   // e.g. "bookmarklet"
}
```

---

## Endpoint Contract

### POST /api/capture/:captureToken

Request:
- Method: POST
- Content-Type: text/plain (body is JSON — CORS simple request, no preflight)
- Token in URL path (no custom headers needed)

Body fields:

| Field    | Type   | Required | Notes |
|----------|--------|----------|-------|
| `url`    | string | yes      | Captured page URL (must be http/https) |
| `title`  | string | no       | Document title |
| `note`   | string | no       | Selected text, capped at 8 KB server-side |
| `ts`     | string | no       | Client ISO-8601 timestamp |
| `source` | string | no       | Origin hint, e.g. `bookmarklet` |

Processing order:
1. Resolve token → 401 if unknown or revoked
2. KV rate-limit check → 429 if exceeded
3. Validate `url` is http/https → 400 if invalid
4. Dedupe check (KV TTL key) → 204 (silent drop) if duplicate
5. Write dedupe key
6. Dispatch to adapter (saved-list sync, email via `ctx.waitUntil`, github via `ctx.waitUntil`)
7. Respond 204

Responses:

| Code | Meaning |
|------|---------|
| 204  | Accepted |
| 400  | Malformed payload |
| 401  | Unknown or revoked token |
| 413  | Payload too large |
| 429  | Rate limited |
| 5xx  | Server error |

Response always sets `Access-Control-Allow-Origin: *`.

### POST /api/capture/token (token management)

Generates or rotates the capture token for a sync room.

- Auth: Bearer token — the client's sync room bearer token (the same secret
  used for `PUT /sync/{roomId}/meta`). Verified by SHA-256 comparison against
  the hash stored in R2 at `{roomId}/.token`.
- Body: `{ roomId: string, destinationType: string, destinationConfig?: object }`
- Response: `{ captureToken: string }` — the raw token only. The bookmarklet
  `javascript:` URL is constructed **client-side** from the known host and the
  returned token. No server round-trip needed for bookmarklet text.

On rotation: old token key deleted from KV; new token written. Does not touch
the sync URL or room token.

### DELETE /api/capture/token

Revokes the current capture token for a room.

- Auth: Bearer token
- Body: `{ roomId: string }`
- Response: 204

---

## Adapters

**Dispatch strategy:**
- `saved-list` — synchronous, before the 204 response. R2 read+write only, no
  external API call. Fast enough not to delay the response meaningfully.
- `email` and `github` — via `ctx.waitUntil`. 204 is sent immediately; delivery
  runs after. Best-effort: a Worker crash mid-delivery loses the capture. This
  matches `sendBeacon` fire-and-forget semantics. No retry queue in v1.

### saved-list

1. Read `{roomId}/meta` from R2 (with ETag).
2. Parse JSON, append capture to `savedArticles[]`. Include `source: "capture"`
   field on the appended item so the UI can distinguish it from feed-sourced saves.
3. Write back with `If-Match: {etag}`. Retry once on 412 (re-fetch + re-append).

Open: exact visual treatment of `source: "capture"` articles in the reader UI.

### email (Resend)

Dispatched via `ctx.waitUntil`. POST to `https://api.resend.com/emails` with
`Authorization: Bearer ${RESEND_API_KEY}`.

Subject: `[capture] <title or url>`
Body (plain text): url, title, note, ts, source.

### github

Dispatched via `ctx.waitUntil`. GitHub Contents API with `Authorization: Bearer ${GITHUB_PAT}`.

1. GET file (read SHA + content).
2. Append entry: `- [ ] <title> — <url>  <!-- note: <note> | ts: <ts> -->`
3. PUT file with `sha` field (commit). Retry once on SHA conflict (re-fetch and retry).

---

## Bookmarklet Template

`WORKER_URL` and `CAPTURE_TOKEN` injected at generation time (client-side, in
`buildBookmarklet`). The bookmarklet opens a popup to `GET /save/:token` rather
than POSTing in the background — a top-level navigation that ad/tracker blockers
allow (see Amendments). The popup page saves server-side and auto-closes; the
selection is capped so the data fits in the URL.

```javascript
javascript:(function(){
  var s = window.getSelection ? String(window.getSelection()).slice(0,500) : '';
  var u = 'https://WORKER_URL/save/CAPTURE_TOKEN'
        + '?u='  + encodeURIComponent(location.href)
        + '&ti=' + encodeURIComponent(document.title)
        + '&n='  + encodeURIComponent(s);
  window.open(u, 'boomerang', 'width=420,height=220');
})();
```

---

## Settings UI

New "Capture" section in the existing Settings component (`news-feed/src/components/Settings.tsx`).

Panels:
- **Bookmarklet** — display `javascript:` snippet constructed client-side from
  `BOOMERANG_HOST` (known at build time) and the stored capture token. Drag-to-
  bookmark-bar affordance. "Regenerate" button calls `POST /api/capture/token`
  and updates the displayed snippet.
- **Destination** — picker: `saved list | email | github`. Per-adapter config
  fields shown conditionally.
  - Email: destination address input.
  - GitHub: owner/repo, file path, branch inputs. The `GITHUB_PAT` Worker secret
    is configured separately (not editable via the UI); UI only stores repo metadata.

Save flow: UI calls `POST /api/capture/token` (auth: room bearer token). Server
writes to CAPTURE_TOKENS KV and returns the new `captureToken`. Client stores
the token and constructs the bookmarklet snippet locally.

---

## Canonical Vocabulary

| Term | Definition |
|------|-----------|
| **capture** | A page-save event initiated by the user clicking the bookmarklet |
| **capture token** | 32-byte base64url bearer token embedded in the bookmarklet; maps to one user's room and destination config; `capture:create` scope only |
| **capture record** | Normalized `{ id, url, title, note, ts, source }` object passed to the adapter |
| **destination** | Where a capture is routed. Single destination: `saved-list` (see Amendments) |
| **bookmarklet** | The `javascript:` snippet generated client-side; opens a popup to `/save/:token` with the capture token embedded |
| **save page** | `GET /save/:token` — the popup target that records the capture server-side and auto-closes |
| **saved-list adapter** | Appends the capture to `savedArticles[]` in the sync room meta |
| **revocation** | Deleting the capture token from KV; the old bookmarklet stops working immediately |
| **rotation** | Revocation + generation of a new capture token; produces a new bookmarklet |
| **roomId** | The sync room identifier that links a capture token to the user's boomerang data; also the credential a downstream reader (victusama) uses |

---

## Open Questions

1. How should captured articles be visually distinguished from feed-sourced saves in the reader UI?
2. Should `note` field have a configurable cap or always 8 KB? (Popup path caps the selection at 500 chars to fit the URL; server cap is 8 KB.)
3. Rate limit defaults — configurable per-token in KV, or global worker config only?
