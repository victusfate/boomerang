# Boomerang — Static Analysis & Code Review

_2026-05-29 · Claude Code (Opus 4.8)_

Full-repo static analysis and code review across `news-feed/`, `platform-worker/`,
and `shared/`. Findings below were produced by two deep-review passes (one per
package) plus a build/config/dependency sweep. **All Critical and High findings
were manually verified against source** (file:line confirmed); Medium/Low are
reported as found.

## Summary

| Severity | news-feed | platform-worker | build/deps | Total |
|---|---|---|---|---|
| Critical | 2 | 1 | 0 | **3** |
| High     | 5 | 3 | 1 | **9** |
| Medium   | 10 | 7 | 0 | **17** |
| Low      | 8 | 6 | 2 | **16** |

**Tooling status:** 0 npm vulnerabilities (both packages); news-feed typechecks
clean; platform-worker tests 16/16 pass; **platform-worker `typecheck` is broken**
(see B-1).

### Fix first (highest leverage)
1. **PW-C1** — `/recommendations` global path returns HTTP 500 once `item_factors > 100` (production breakage as data grows).
2. **NF-C1 / NF-C2** — `javascript:` URL XSS via article links and `discussionUrl`.
3. **PW-H1 + PW-H2 + PW-L5** — SSRF cluster on `/og-image`, `/image`, `/bundle?customFeeds` (redirect-follow + porous IP allow-list).
4. **PW-H3** — `X-Forwarded-For` rate-limit bypass in rec + meta domains (same bug PR #50 fixed in sync, but these copies were missed).
5. **B-1** — platform-worker `typecheck` permanently fails; any CI gate on it is red or ignored.

---

## Build / Config / Dependencies

### [HIGH] B-1 — platform-worker `typecheck` is permanently broken
`platform-worker/tsconfig.json` lacks `allowImportingTsExtensions: true`, yet four
files import with explicit `.ts` extensions, producing `TS5097` on every run:

```
src/domains/meta/articleRecord.ts:3
src/domains/rec/articleMetaContract.ts:8
src/domains/rec/articleMetaKv.ts:12,18
```

`news-feed/tsconfig.json` already sets the flag (and uses `.ts` imports in 19
files without issue). The config has `moduleResolution: "Bundler"` + `noEmit: true`,
so the flag is valid here.

**Fix:** add `"allowImportingTsExtensions": true` to `platform-worker/tsconfig.json`
`compilerOptions`. One line; turns the typecheck green and restores its value as a
CI gate.

### [LOW] B-2 — No linter anywhere in the repo
Neither package has a `lint` script or ESLint config. Many findings below
(unsanitized URLs, empty catches, unbounded Maps, missing deps in hooks) are
exactly what `eslint` + `eslint-plugin-react-hooks` + a `no-unsanitized` rule
would catch automatically.

### [LOW] B-3 — Silent empty catch blocks
`news-feed/src/hooks/useOGImageBatch.ts:49` (`} catch {}`) swallows errors with no
log. The fire-and-forget `.catch(() => {})` cases (`newsService.ts:298`,
`rec/index.ts:379`, `rss/index.ts:95`) are intentional background writes — acceptable,
but the `useOGImageBatch` one should at least debug-log.

---

## platform-worker

### [CRITICAL] PW-C1 — Global `/recommendations` path crashes once `item_factors > 100`
`src/domains/rec/RecDO.ts:120-126`, `src/domains/rec/index.ts:308-318`
The known ricochet SQL-variable bug (`docs/review/ricochet-sql-variables-bug.md`)
**is reachable through this worker**. `GET /recommendations/:userId` with no
`candidates` param leaves `candidateIds` undefined, and the Boomerang `RecDO`
override forwards to `super.fetch()` (RecDO.ts:125), which runs the base
`scoreCandidates` over up to `GLOBAL_CANDIDATE_LIMIT = 200` candidates → SQLite
`too many SQL variables` → HTTP 500. The interim mitigation suggested in the bug
doc (cap forwarded candidate count to ≤100) is **not** implemented. `/recommendations/`
is publicly routed, so any store with >100 item factors returns 500 on the global
path. _(Verified: override forwards to `super.fetch()` with no cap.)_

**Fix:** in the global branch, cap candidate generation to ≤100 until the upstream
chunking fix ships; bump ricochet once it's released.

### [HIGH] PW-H1 — SSRF: og-image/image proxy follows redirects without re-validation
`src/domains/rss/index.ts:118-119, 165-166`
`isAllowedOgFetchUrl(target)` validates only the initial URL, but both fetches use
`redirect: 'follow'`. A public URL that 302-redirects to `http://169.254.169.254/…`
or an internal host is followed with no re-check. DNS rebinding (a public hostname
resolving to a private IP) also passes the string-based allow-list. _(Verified:
`redirect: 'follow'` at both sites.)_

**Fix:** use `redirect: 'manual'`, re-validate each `Location` against
`isAllowedOgFetchUrl`, cap redirect count. Ideally allow-list expected article
hostnames rather than allow-all-public.

### [HIGH] PW-H2 — SSRF allow-list misses IPv6 + non-dotted IPv4 forms
`src/domains/rss/ogImage.ts:49-77`
The IPv4 guard regex `^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$` matches dotted-quad
only. These fall through to `return true`:
- Decimal `http://2130706433/` (= 127.0.0.1), hex `http://0x7f000001/`, octal, short `http://127.1/`
- IPv4-mapped IPv6 `[::ffff:127.0.0.1]`, `[::ffff:10.0.0.1]`
- `::1` when workerd returns it without brackets (the `startsWith('[')` guard misses it)
- Broadcast `255.255.255.255`, multicast `224.x`

_(Verified: regex + bracket-only IPv6 check confirmed.)_

**Fix:** reject any hostname that is purely numeric/hex/octal; normalize via integer
parsing; add IPv6 ULA (`fc00::/7`), link-local (`fe80::/10`), loopback, and
IPv4-mapped handling.

### [HIGH] PW-H3 — `X-Forwarded-For` rate-limit bypass in rec + meta domains
`src/domains/rec/index.ts:90-96`, `src/domains/meta/index.ts:31-38`
Both `getClientIp` implementations fall back to client-controlled `X-Forwarded-For`
when `CF-Connecting-IP` is absent. An attacker rotates XFF to forge unlimited
distinct rate-limit keys, bypassing per-IP limits on `/interactions`,
`/recommendations`, `/rec/articles`, `/meta`, `/meta/tags`. **PR #50 fixed exactly
this in `sync/index.ts` — the rec and meta copies were missed.** _(Verified: XFF
read at rec:93 and meta:34.)_

**Fix:** drop the XFF fallback in both files; use only `CF-Connecting-IP` (match sync).

### [MEDIUM] PW-M1 — Rate-limit check mis-indented inside `try` (recs)
`src/domains/rec/index.ts:264-266` — `limited` declared inside `try`; a throw inside
`checkRateLimit` would surface as `rec_internal_error` (500) instead of the correct
response. Verify brace structure; likely an editing accident.

### [MEDIUM] PW-M2 — `/rec/debug` is unauthenticated and unrate-limited
`src/domains/rec/index.ts:385-397` — returns global model state, factor/interaction
counts, KV counters to any caller; 4 parallel DO round-trips make it a cheap
amplification lever. Gate behind auth or remove from the public router.

### [MEDIUM] PW-M3 — Error responses leak internal exception messages
`src/index.ts:56-64` (`detail: err.message`), `rec/index.ts:330, 362` — raw
`err.message` / DO error bodies returned to clients expose SQLite errors and
internals. Log server-side; return a generic message.

### [MEDIUM] PW-M4 — Body-size cap applied only after full buffering when Content-Length absent
`rss/index.ts:129-133, 181-187`, `rssFetch.ts:32-35` — when CL header is missing,
the code buffers the full `arrayBuffer()` before checking size. Memory-pressure
lever under concurrency. Stream and abort once the byte budget is exceeded.

### [MEDIUM] PW-M5 — MetaDO heartbeat is dead code
`src/domains/meta/MetaDO.ts:115-125` — `ping()` is never invoked (no alarm, no
`setWebSocketAutoResponse`). `missedPongs` never increments; `MAX_MISSED_PONGS`
timeout never fires; dead/half-open WebSocket sessions are only cleaned on explicit
close. Schedule via DO alarms or remove the scaffolding.

### [MEDIUM] PW-M6 — MetaDO session state lost on hibernation
`src/domains/meta/MetaDO.ts:26, 57, 68-82` — `acceptWebSocket` enables hibernation,
but `SessionState` (subscribedIds, msgCount) lives only in the in-memory `sessions`
Map. After hibernation, `webSocketMessage` gets `undefined` → returns early →
subscriptions silently stop delivering `tags` broadcasts; `webSocketOpen` re-seeds
with empty `subscribedIds`. Persist via `ws.serializeAttachment()` / restore in the
handler.

### [MEDIUM] PW-M7 — Sync blocks/meta GET unauthenticated (capability-URL model?)
`src/domains/sync/index.ts:78-87, 110-119` — read paths require only the 64-hex
roomId (no token), and blocks carry `Cache-Control: public` (shared-cache readable).
Confirm this is the intended capability-URL threat model; the read=no-auth /
write=token asymmetry plus public caching deserves an explicit decision.

### [LOW] PW-L1 — `/sync/room` rate-limit disabled when CF-Connecting-IP missing
`sync/index.ts:67-68` — room creation is unbounded if the header is ever absent.
Minor (CF always sets it in prod).

### [LOW] PW-L2 — Rate-limit Maps are per-isolate → effective limit is N× looser
`sync/index.ts:8`, `rec/index.ts:21`, `meta/index.ts:9` — module-level Maps mean each
isolate enforces its own counter. True limit ≈ `MAX × isolateCount`. For real limits
use a DO/KV-backed counter. (Already noted as deferred in `security-findings.md`.)

### [LOW] PW-L3 — `checkRateLimit` off-by-one allows MAX+1 per window
`sync/index.ts:42-55`, `rec/index.ts:108-121` — first request sets `count:1` and
returns; the `>= max` check runs before increment, so `MAX+1` requests pass.

### [LOW] PW-L4 — Enclosure/media URLs not scheme-validated at parse time
`parseFeed.ts:121-148` — raw `@_url` returned; validated later in
`resolveArticleImageUrl`, so server-side OK. Flagged for completeness — emitted to
clients, see NF-L8.

### [LOW] PW-L5 — `/bundle?customFeeds` is a second SSRF vector
`rss/index.ts:39-61` — user-supplied `feedUrl`s gated only by `isAllowedOgFetchUrl`
(same weaknesses as PW-H2), and `fetchXmlWithRetry` (`rssFetch.ts:23`) has no
redirect re-validation. Fix alongside PW-H1/H2.

### [LOW] PW-L6 — MetaDO upgrades to WebSocket for any non-`/prune` request
`MetaDO.ts:44-66` — the DO returns 101 without checking the `Upgrade` header (the
check exists only in the worker router). The DO is the trust boundary and shouldn't
assume the router guarded it.

### Verified OK (platform-worker)
- All SQL in `RecDO.ts` / `MetaDO.ts` uses `?` bind params — no string-interpolated
  user input. The only `IN (...)` placeholder generation is upstream ricochet (PW-C1).
- Sync token compare is SHA-256-hashed (`auth.ts:13-19`); not constant-time but
  256-bit random tokens make timing attack impractical.
- CORS allows any `*.pages.dev` over https — broad but intentional for previews;
  `Vary: Origin` set.

---

## news-feed

### [CRITICAL] NF-C1 — `javascript:` URL XSS via article links
`src/components/ArticleCard.tsx:13, 16` → sinks at `135` (`window.open`), `150, 177,
255, 271` (`href`)
`normalizeArticleNavUrl` returns `raw.trim()` (the original string) for non-http/https
protocols **and** in the `catch` branch, instead of blocking. A `javascript:` or
`data:text/html,…` value in `article.url` executes on click. The function comment
says it should "match worker `normalizeHttpUrl`" (which PR #50 fixed to return `''`) —
this is the defense-in-depth copy with the bug still present. _(Verified line 13/16.)_

**Fix:** return `''` (or `'about:blank'`) for non-http/https and in the `catch`.

> Mitigation in place: the RSS worker now strips bad schemes from `article.url`
> server-side (PR #50). This client bug matters for imported bookmarks/OPML and as
> defense-in-depth — and is the only guard for NF-C2.

### [CRITICAL] NF-C2 — `discussionUrl` rendered in `href` with no sanitization
`src/components/ArticleCard.tsx:281` — `article.discussionUrl` (from the RSS
`<comments>` field) goes straight into an anchor `href` with no protocol check at all.
A `javascript:` value executes on click. _(Verified: raw `href={article.discussionUrl}`.)_

**Fix:** run `discussionUrl` through the (fixed) `normalizeArticleNavUrl` before
rendering; confirm whether the worker sanitizes the comments field too.

### [HIGH] NF-H1 — `postInteractions` ignores HTTP error status
`src/services/recWorker.ts:57-68` — never checks `res.ok`. A 4xx/5xx that returns a
body doesn't throw, so the caller's catch/re-queue never fires and those interactions
are lost silently. Add `if (!res.ok) throw …` (consistent with every other fetch in
the file).

### [HIGH] NF-H2 — Unbounded module-level ETag cache + residual key collision
`src/services/recWorker.ts:77` — `recETagStore` has no size cap/eviction; grows
monotonically over a long PWA session. The key `${userId}:${candidateArticleIds[0]}`
(added this session to fix the per-chunk collision) still collides across different
pools that share a leading article ID. Add an LRU cap (~50) and strengthen the key
(include pool length or a short hash of more IDs).

### [HIGH] NF-H3 — Untracked conflict-retry `setTimeout` leaks on unmount + unbounded retry
`src/hooks/useSyncWorker.ts:278` — `setTimeout(() => void doPush(…), 500)` handle is
never stored, so the cleanup effect can't clear it; firing post-unmount touches
`roomRef.current` (null) and dead setters. A perpetual-conflict scenario loops with
no depth cap. Store in a ref, clear on cleanup, add a max-retry counter.

### [HIGH] NF-H4 — `forceSync` recreated every 500 ms → event-listener churn
`src/hooks/useSyncWorker.ts:349`, `src/App.tsx:244-252` — `forceSync` lists
`syncCooldownMs` in its dep array; the cooldown ticks every 500 ms, so the
`visibilitychange` effect tears down and re-adds its listener ~30× per cooldown.
Move the cooldown guard into a ref check (drop it from the dep array) or wrap with the
stable-ref pattern already used for `forceMetaSync`.

### [HIGH] NF-H5 — Full prefs (incl. read/seen history) serialized into URL fragment
`src/services/syncShare.ts:165-189` — the share hash is the entire prefs JSON
base64-encoded. With thousands of `seenIds`/`readIds` it overruns browser URL limits
→ silent truncation → `parseSyncHash` returns null (sync data lost). Also leaks
`keywordWeights`, `topicWeights`, subscriptions, read history, and saved URLs into
browser history / Referer. Move the payload to a server-side sync PUT and share only
the room token; at minimum strip `seenIds`/`readIds` from the hash.

### [MEDIUM] NF-M1 — Deleted-label filter shows all articles instead of none
`src/App.tsx:343-346` — unknown label ID → `labelName = ''` → `t.includes('')` always
true → entire feed passes. Guard `if (!labelName) return false`.

### [MEDIUM] NF-M2 — `tags.join()` equality false-negative on comma tags
`src/hooks/useSyncWorker.ts:210` — `['a','b'].join()` === `['a,b'].join()`. Diagnostic-only
(corrupts debug `newTags` counts). Use `JSON.stringify([...tags].sort())`.

### [MEDIUM] NF-M3 — Startup `Promise.all` has no unmount guard
`src/hooks/useFeed.ts:476-575` — `.then` calls many setters with no cancellation; on
unmount before IndexedDB resolves (slow device, HMR) they fire on an unmounted
component. Add a `mounted` flag / `AbortController`.

### [MEDIUM] NF-M4 — O(n) `includes` per render in `ArticleCard`
`src/components/ArticleCard.tsx:75-77`, `src/services/storage.ts:58, 72` —
`savedIds/upvotedIds/downvotedIds.includes(id)` runs per card per render. ~100 cards ×
1000 saved IDs ≈ 300k comparisons each time App state changes. Derive `Set`s with
`useMemo` and pass down.

### [MEDIUM] NF-M5 — No `React.memo` on `ArticleCard`
`src/components/ArticleCard.tsx` — every App state change (500 ms cooldown tick,
`lastRefresh` formatting, `feedEnterIds` clear) re-renders all visible cards. Wrap in
`React.memo` (compounds with NF-M4).

### [MEDIUM] NF-M6 — Bundle JSON response shape not validated
`src/services/newsService.ts:197, 228` — `res.json()` cast unchecked; a Cloudflare HTML
error page → `data.articles` undefined → `.map` throws `TypeError`. Guard
`Array.isArray(data?.articles)`.

### [MEDIUM] NF-M7 — History replay sends `ts: now` for non-save interactions
`src/hooks/useRecHistoryReplay.ts:108-119` — `upvote`/`downvote`/`read` replay with
current time, not actual interaction time (only saves use `savedAtById`). Distorts the
rec model's recency-weighted signal. Add `readAtById`/`upvotedAtById`/`downvotedAtById`
to `UserPrefs`, or document the limitation.

### [MEDIUM] NF-M8 — Save-timestamp migration crushes all history into a 1-second window
`src/hooks/useFeed.ts:436-441` — `base = Date.now() - savedIds.length` (ms) puts 500
historical saves within the last half-second; cross-device sort treats them as
simultaneous. Use a larger unit, e.g. 60_000 ms per save.

### [MEDIUM] NF-M9 — OPML import URLs not protocol-validated
`src/services/storage.ts:434-479` — `xmlUrl` values become custom `feedUrl`s with no
scheme/host check; feeds the worker's `/bundle` SSRF surface (PW-L5). Validate
`http:`/`https:` before accepting.

### [MEDIUM] NF-M10 — `onRenameLabel` is dead code
`src/hooks/useFeed.ts:1113`; not destructured in `App.tsx`; no UI in `Settings.tsx`.
`renameUserLabel` is unreachable. Wire it up or remove (see NF-L7 for the latent
data-consistency bug it would expose).

### [LOW] NF-L1 — `flush` has no in-flight guard
`src/hooks/useRecWorker.ts:122-132` — interval timer + batch-size trigger can both call
`flush`; correct only by single-threaded timing luck. Add `flushInFlightRef`
(matching `fetchPoolRecs`).

### [LOW] NF-L2 — `useMetaWorker.syncNow` stale-closure churn
`src/hooks/useMetaWorker.ts:119-154` — recreated every 500 ms during cooldown (same
shape as NF-H4).

### [LOW] NF-L3 — `normalizeArticleNavUrl` catch returns raw value
`src/components/ArticleCard.tsx:16` — amplifies NF-C1; malformed inputs that throw in
`URL()` bypass even the protocol check. Return `''`.

### [LOW] NF-L4 — 32-bit bookmark hash collides at ~54K items
`src/services/storage.ts:484-489` — birthday bound; two URLs sharing an ID silently
merge. Unlikely in practice; use a wider hash if bookmark counts could grow.

### [LOW] NF-L5 — O(n²) binary-string building via `+=`
`src/services/newsService.ts:188-191`, `syncShare.ts:26`, `storage.ts:311` — char-by-char
concat. For large prefs (sync share) this can freeze the UI. Use
`Array.from(bytes, b => String.fromCharCode(b)).join('')`.

### [LOW] NF-L6 — Sensitive data logged unconditionally in production
Multiple files — sync payload sizes, article text to the on-device LLM, label names.
Visible to extension content scripts. Gate behind a debug flag.

### [LOW] NF-L7 — Label rename doesn't update tag-name strings
`src/services/storage.ts:554-558`, `src/hooks/useFeed.ts:794-796` — `renameUserLabel`
updates only `UserLabel.name`; `ArticleTag.tags` stores the name string, so renamed
labels desync. Latent (gated by NF-M10) but would surface if rename is wired up.

### [LOW] NF-L8 — `imageUrl`/`ogImageUrl` not scheme-checked before `<img src>`
`src/components/ArticleCard.tsx:183-189` — browsers block `javascript:` in `src`, but
`data:` is honored. Low risk; validate scheme for consistency.

---

## Cross-cutting themes

1. **Defense-in-depth URL sanitization is incomplete.** PR #50 fixed the worker's
   `normalizeHttpUrl`, but the client twin (NF-C1), `discussionUrl` (NF-C2),
   `imageUrl` (NF-L8), and OPML import (NF-M9) all still pass URLs through without a
   correct scheme check. A single shared `safeHttpUrl(raw): string` helper in
   `shared/` used by both worker and client would close all of these at once.

2. **`X-Forwarded-For` trust is inconsistent across domains.** Sync was fixed
   (PR #50); rec and meta still trust it (PW-H3). Extract one `getClientIp` into a
   shared module so the fix can't drift again.

3. **Per-isolate, off-by-one, in-memory rate limiting** (PW-L2/L3, plus the module
   Maps) — all three domains reimplement the same limiter with the same flaws. One
   shared, DO/KV-backed limiter would fix correctness and consolidation together.

4. **500 ms cooldown ticks drive avoidable re-renders and callback churn**
   (NF-H4, NF-L2, NF-M5) — cooldown state should live in a ref / isolated component,
   not in callback dep arrays and top-level App state.

---

## Appendix — verification status

Manually confirmed against source this review: B-1, PW-C1, PW-H1, PW-H2, PW-H3,
NF-C1, NF-C2. Remaining Medium/Low findings reported as produced by the per-package
review passes; line numbers are accurate as of commit on `main` at review time.
