# Boomerang — Security Findings
_May 2026 · Claude Code_

## Summary

| Severity | Found | Patched in this PR | Deferred |
|---|---|---|---|
| Critical | 2 | 1 (IPv4 logic bug) | 1 (sync token storage — design tradeoff) |
| High | 4 | 3 (auth order, XFF, console log) | 1 (in-memory rate limiting) |
| Medium | 3 | 0 | 3 (CSP, CORS scope, token expiry) |
| Low | 5 | 1 (article URL injection) | 4 |

---

## Patched

### [CRITICAL] IPv4 allow-list logic had dead `return false` — `ogImage.ts:73`
The `isAllowedOgFetchUrl()` function checked all private/reserved IPv4 ranges (loopback, RFC-1918, link-local, shared space) but then always returned `false` instead of `true` for public IPs. Public IPv4 og-image URLs were incorrectly blocked; more importantly the intent of the code was obscured.

**Fix**: Changed `return false` → `return true` with comments on each range.

### [HIGH] Auth checked after rate-limit for PUT/DELETE sync routes — `sync/index.ts`
For `PUT /sync/{roomId}/blocks/{cid}`, `PUT /sync/{roomId}/meta`, and `DELETE /sync/{roomId}`, the rate-limit bucket was consumed before token verification. An attacker could exhaust the per-room rate limit with invalid tokens, locking out legitimate users.

**Fix**: Token verification now runs first for all three authenticated routes; rate-limit only consumed on valid tokens.

### [HIGH] `X-Forwarded-For` fallback allowed IP spoofing — `sync/index.ts:34`
`getClientIp()` fell back to `X-Forwarded-For` when `CF-Connecting-IP` was absent. `X-Forwarded-For` is user-controlled, allowing attackers to forge their source IP and bypass per-IP rate limits.

**Fix**: Removed `X-Forwarded-For` fallback entirely. Cloudflare always sets `CF-Connecting-IP`; the fallback was dead code in production.

### [HIGH] roomId logged to console on sync errors — `useSyncWorker.ts:107`
`logSyncError()` passed the full 64-hex-char roomId and workerUrl to `console.error()`, making them visible in browser DevTools, error reporting services, and browser extensions.

**Fix**: Console output now shows only a 6-char hint (`abc123…`). Full details go only to the in-memory `syncDebugLog` which is never transmitted externally.

### [LOW] Article URLs from feeds not validated for safe scheme — `parseFeed.ts:65`
`normalizeHttpUrl()` returned the raw URL string when the protocol wasn't `http`/`https`, which would pass `javascript:` or `data:` URLs through to the frontend unchanged.

**Fix**: Returns `''` for any non-http/https URL. The frontend has a second layer of validation in `ArticleCard.tsx`, but defense-in-depth applies.

---

## Deferred (needs design decision or larger refactor)

### [CRITICAL] Sync token in localStorage and URL fragment
The sync token is stored in `localStorage` in plain text, displayed in the Settings UI, and embedded in the URL fragment for sharing. This is largely **by design** — the sync feature's UX depends on users being able to copy/share the link.

**Mitigations already in place**: Token is in the URL fragment (not query string, so never sent to servers); fragment is not in browser history sent to analytics. Token is a 32-byte random value with no server-side session.

**Remaining risk**: Browser extensions with `tabs` permission, malicious scripts with page access, or physical screen access can capture the token.

**Recommendation for next sprint**:
- Mask token in Settings UI behind a "reveal" toggle (show only first/last 4 chars)
- Add a warning: "Anyone with this link can read and modify your synced data"
- Consider token rotation on explicit "Generate new link" action

### [HIGH] In-memory rate limiting doesn't survive worker restarts — all domains
Rate buckets are stored in module-level Maps. Cloudflare Workers restart frequently; buckets reset on each cold start. A sustained burst during a cold-start window bypasses rate limiting.

**Recommendation**: Migrate to Cloudflare KV or a Durable Object counter for persistent rate limiting. Low urgency for current traffic volume.

### [MEDIUM] No Content Security Policy
No CSP meta tag or header in `news-feed/`. Adding a CSP requires enumerating all connect-src origins (platform-worker varies by deployment) but would significantly reduce XSS blast radius.

**Recommended CSP** (add to `news-feed/index.html`):
```html
<meta http-equiv="Content-Security-Policy"
  content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
           img-src 'self' data: https:; connect-src 'self' https:;
           frame-src 'none'; object-src 'none';">
```
Note: `unsafe-inline` for styles is needed by Vite's CSS injection. Tighten in a follow-up.

### [MEDIUM] `.pages.dev` CORS allowlist is overly broad — `cors.ts`
Any Cloudflare Pages project can call the worker. Acceptable for a public API but could be tightened to the specific project subdomain.

### [LOW] No sync token expiration
Tokens are valid indefinitely. Recommend 90-day expiration with a refresh endpoint.

### [LOW] No rate limit on `/sync/room` creation
Each room consumes R2 quota. The existing per-IP rate limit (30 req/min) provides some protection but no global cap. Monitor R2 usage.
