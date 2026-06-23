# Capture Connector — Design

## Purpose

Let a user save the page they are on by clicking a bookmarklet. The page data
is POSTed to boomerang. Boomerang routes it to the destination that user has
configured. Generic connector: a news reader gains a "send this anywhere"
capability.

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
type CaptureTokenRecord =
  | { roomId: string; destinationType: 'saved-list' }
  | { roomId: string; destinationType: 'email';   destinationConfig: EmailConfig }
  | { roomId: string; destinationType: 'github';  destinationConfig: GitHubConfig };

// Zero additional config — the adapter writes to the room's own savedArticles[].
// No EmailConfig / GitHubConfig variant needed for saved-list.

interface EmailConfig {
  toAddress: string;
}

interface GitHubConfig {
  owner:  string;
  repo:   string;
  path:   string;  // e.g. "inbox/captures.md"
  branch: string;
}
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

`BOOMERANG_HOST` and `CAPTURE_TOKEN` injected at generation time (server-side).

```javascript
javascript:(function(){
  var d=document, w=window;
  var payload=JSON.stringify({
    url: w.location.href,
    title: d.title,
    note: (w.getSelection ? String(w.getSelection()) : ''),
    ts: new Date().toISOString(),
    source: 'bookmarklet'
  });
  var blob=new Blob([payload], {type:'text/plain'});
  var ok=navigator.sendBeacon('https://BOOMERANG_HOST/api/capture/CAPTURE_TOKEN', blob);
  var n=d.createElement('div');
  n.textContent = ok ? 'Saved to boomerang' : 'Capture failed to queue';
  n.style.cssText='position:fixed;z-index:2147483647;top:12px;right:12px;padding:8px 12px;'
    +'font:13px/1.3 system-ui,sans-serif;color:#fff;border-radius:6px;'
    +'background:'+(ok?'#1a7f37':'#b91c1c')+';box-shadow:0 2px 8px rgba(0,0,0,.3)';
  d.body.appendChild(n);
  setTimeout(function(){ n.remove(); }, 1800);
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
| **capture record** | Normalized `{ id, url, title, note, ts, source }` object passed to adapters |
| **destination** | Where a capture is routed: `saved-list`, `email`, or `github` |
| **destination config** | Per-adapter settings stored in the CAPTURE_TOKENS KV record |
| **bookmarklet** | The `javascript:` URL snippet generated by boomerang with the capture token embedded |
| **saved-list adapter** | Appends the capture to `savedArticles[]` in the sync room meta |
| **email adapter** | Sends the capture via Resend to the user's configured destination address |
| **github adapter** | Appends a markdown entry to a file in the user's configured repo via GitHub Contents API |
| **revocation** | Deleting the capture token from KV; the old bookmarklet stops working immediately |
| **rotation** | Revocation + generation of a new capture token; produces a new bookmarklet |
| **roomId** | The sync room identifier that links a capture token to the user's boomerang data |

---

## Open Questions

1. How should captured articles be visually distinguished from feed-sourced saves in the reader UI?
2. Should `note` field have a configurable cap or always 8 KB?
3. Rate limit defaults — configurable per-token in KV, or global worker config only?
