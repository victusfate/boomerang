# Plan: Fireproof → plain IndexedDB KV

## Slices

### Slice 1 — KV service module
Create `news-feed/src/services/kvStore.ts`:
- Module-level cached `dbPromise`
- `openDb()` — opens `boomerang-kv` v1 with a single `kv` object store
- `kvGet<T>(key)` — readonly transaction, returns `T | undefined`
- `kvSet(key, value)` — readwrite transaction
- `kvDelete(key)` — readwrite transaction

### Slice 2 — Migrate useFeed startup reads
In `useFeed.ts`:
- Replace `useFireproof` import + `const { database }` with nothing (no hook)
- Replace the five `database.get<T>(ID)` calls with `kvGet<T>(ID)` calls
- Remove Fireproof doc types' `_id` field (stored value no longer needs it)
- Keep the same `.catch(() => default)` fallback pattern

### Slice 3 — Migrate useFeed writes
Replace every `database.put({ _id: X, ...payload })` with `kvSet(X, payload)`.
Covers: `updatePrefs`, `handleSeen`, `handleSave`, sync startup writes, `applyRemoteSync`, `handleDeleteLabel`, `handleAddManualTag`, `handleRemoveManualTag`, `handleImportBookmarks`, `refresh` (feed-cache write), etc.

### Slice 4 — Remove Fireproof dependency
- `npm uninstall use-fireproof` in `news-feed/`
- Remove `use-fireproof` from `package.json` + `package-lock.json`
- Confirm `npm run typecheck` and `npm run build` pass

## Out of scope
- Any data migration from old Fireproof IndexedDB (start fresh, by design)
- Adding indexes, versioned schema migrations, or complex queries
- Changing any sync-worker or meta-worker code
