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
