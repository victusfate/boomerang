# TDD log — ucan-sync-worker

| Slice | Status | Notes |
|-------|--------|-------|
| S1 | done | sync-worker scaffold: wrangler.jsonc, R2 binding, CORS, /health |
| S2 | done | POST /sync/room — roomId (64 hex) + base64url token, SHA-256 hash stored in R2 |
| S3 | done | PUT/GET /sync/{roomId}/blocks/{cid} — auth on PUT, block dedup (204 on repeat) |
| S4 | done | PUT/GET /sync/{roomId}/meta — auth on PUT, ETag returned on GET, 412 on If-Match mismatch |
| S5 | done | DELETE /sync/{roomId} — removes all room keys from R2 |
| S6 | done | syncWorker.ts client service + useSyncWorker hook (polling 30s + visibilitychange, debounced push, conflict retry) |
| S7 | done | Settings UI — inactive: generate link button; active: sync status dot + copy/QR + revoke |
| S8 | done | Removed syncShareUrl from useFeed return and Settings props; parseSyncHash kept in useFeed |
