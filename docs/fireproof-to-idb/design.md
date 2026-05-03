# Design: Migrate from Fireproof to plain IndexedDB KV

## Q&A

**Q1: Data migration strategy?**
Start fresh — drop old Fireproof data, no migration shim. Users with sync enabled recover automatically on next pull. Feed cache regenerates on next fetch. Accepted: losing local-only state for users with no sync room.

**Q2: Connection management?**
Module-level cached promise so the IDBDatabase is opened once per session, not per operation.

**Q3: Where is Fireproof used?**
`news-feed/src/hooks/useFeed.ts` only. One `useFireproof('boomerang-news')` hook call, five `database.get` calls on startup, ~16 `database.put` calls scattered through the hook.

**Q4: Operations needed?**
Only `get` and `put` (never `delete` or `query`). A `kvDelete` export is worth including for completeness but not used yet.

**Q5: Remove the dependency?**
Yes — uninstall `use-fireproof` from `package.json` after migration.

## Decisions

- Single `kv` object store, string keys, any-JSON values.
- DB name: `boomerang-kv`, version 1.
- Keys stay the same as the old Fireproof `_id` values (`user-prefs`, `feed-cache`, etc.) so if we ever add a migration shim later the key names are stable.
- The `_id` field in the stored objects is no longer needed — values are stored directly (just the payload, no wrapper).
- Document interfaces lose the `& { _id: string }` pattern; types become cleaner.
- `useFireproof` hook is removed; `database` ref is removed from `useFeed`.

## Canonical vocabulary

| Term | Meaning |
|---|---|
| KV store | The plain IndexedDB object store used as a key→value map |
| key | A `string` used to address a persisted document (`'user-prefs'`, `'feed-cache'`, …) |
| value | The JSON-serialisable object stored under a key |
| `kvGet` / `kvSet` / `kvDelete` | Public API of the new storage service |
| document type | The shape of a stored value (e.g. `PrefsDoc`, `FeedCacheDoc`) |

## Edge-case scenarios

- **First load after migration**: all `kvGet` calls return `undefined`; startup code already falls back to defaults via `.catch(() => DEFAULT_PREFS)` — same pattern works.
- **Concurrent writes**: IndexedDB transactions are serialised per store; no extra locking needed.
- **IDB unavailable (private browsing, quota exceeded)**: `openDb` rejects; callers use `.catch(console.error)` so writes silently fail, reads fall back to defaults — same resilience as before.
