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
