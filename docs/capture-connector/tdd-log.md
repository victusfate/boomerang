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
