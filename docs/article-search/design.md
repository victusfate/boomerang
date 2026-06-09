# Design: Article Search

## Status: STUB — to be grilled before PR

This feature is planned to ship in the same branch as `reading-queue`.  
Run `/grill-with-docs` targeting this file to resolve open questions before implementation.

---

## Motivation

When auto-dequeue removes an article from the Queue on open, users lose the ability to find it again via the Queue tab. Search closes this gap: a user can search all articles and filter by "currently in Queue" or "previously saved" to recover something they opened.

It also resolves the general "I saw an article a few days ago" use case.

---

## Known Data Available

| Data | Source |
|---|---|
| All fetched articles (current pool) | `articlePool` in `useFeed.ts` |
| Saved article snapshots (cross-session) | `importedSaves` + `mergePoolWithSavedSnapshots` |
| `savedIds` — currently in Queue | `prefs.savedIds` |
| `unsavedAtById` — previously saved, now removed | `prefs.unsavedAtById` (timestamps) |
| `readIds` — opened articles | `prefs.readIds` |
| Article titles (persisted across sessions) | `titleCache` via `saveTitles` / `persistedTitles` |

---

## Open Questions (to resolve in grill)

1. **Scope of searchable corpus:** Only current RSS pool? Also imported snapshots? Also articles only known by title (from `titleCache`)?
2. **Search location:** New tab? Overlay/modal? Search bar that appears in Feed/Queue tabs?
3. **Filters:** "In Queue", "Previously saved", "Read", or just free-text with no filter UI?
4. **Previously saved corpus:** `unsavedAtById` keys are article IDs — we have timestamps but need titles and URLs. `titleCache` has titles. Do we have enough to show a useful result, or do we need to persist more metadata at dequeue time?
5. **Performance:** Client-side full-text search across potentially thousands of titles — acceptable? Or scope to title-only prefix match?
6. **Entry point:** Is search a fourth tab, a search icon in the header, or a filter within the Queue tab?
