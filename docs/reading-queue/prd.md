# PRD: Reading Queue

## Problem Statement

Users save articles with intent to read them later, but the unbounded "Saved" pile grows faster than they return to it. The mental model of a permanent archive creates anxiety ("reading debt") rather than motivation. Users periodically bulk-unstar everything as a release valve — destroying history without benefit. The fix is to reframe the tab as a bounded, completable reading Queue with a clear done-state and a first-class mass-clear action.

## Solution

Rename the "Saved" tab to "Queue" (display only; internal `FeedView` value stays `'saved'`). Auto-remove articles from the Queue when they are opened, from either the Queue tab or the Feed tab. Add a session-local progress counter and a mass-clear button. Show a done state when the Queue is empty.

## User Stories

1. As a user, I see the tab labeled "Queue" instead of "Saved" so the mental model is a reading list, not an archive.
2. As a user, when I open an article that is currently in my Queue (from either tab), it is automatically removed from the Queue — I do not need to manually unstar it.
3. As a user, opening a Feed article that is not in my Queue has no effect on the Queue.
4. As a user, I still see the ☆/★ button on every card so I can manually add or remove items from the Queue.
5. As a user, when I enter the Queue tab I see a progress counter (`X of Y read`) that tracks how many articles I have opened during this visit.
6. As a user, the progress counter resets each time I navigate to the Queue tab, so I get a fresh baseline each visit.
7. As a user, I see a "Clear all" button at the top of the Queue tab whenever there are articles in the Queue.
8. As a user, pressing "Clear all" removes all remaining articles from the Queue instantly (with no confirmation step — the action matches the existing behavior of manually unstaring everything).
9. As a user, when the Queue is empty I see a done-state message ("Queue cleared") instead of the generic empty-state.
10. As a user, the Queue tab count badge continues to show the number of articles currently in the Queue.
11. As a user, my sync and bookmark-export flows are unaffected — `savedIds` is the same underlying field.
12. As a user, the rec backend continues to receive a `save` signal when I first enqueue an article (unchanged behavior).

## Implementation Decisions

### Module: `services/storage.ts`

Add a pure function `clearQueue(prefs: UserPrefs): UserPrefs`:
- Sets `savedIds: []` and `savedAtById: {}`
- Bulk-writes all cleared IDs to `unsavedAtById` with `Date.now()` as the timestamp (preserves previously-saved history for future search feature)
- Returns the updated prefs

No change to `toggleSaved` — it already handles both individual enqueue and dequeue.

### Module: `hooks/useFeed.ts`

Modify `handleOpen`:
- After calling `markRead` and topic boosts, check `prefsRef.current.savedIds.includes(article.id)`
- If true, also call `toggleSaved(article.id, prefs)` on the result — dequeuing the article
- No change to the rec interaction signal (rec already fires `'read'` regardless of saved state)

Add `handleClearQueue`:
- Calls `updatePrefs(clearQueue(prefsRef.current))`
- Exported as `onClearQueue` in the hook return value

Return type addition: `onClearQueue: () => void`

### Module: `App.tsx`

Tab label:
- "Saved" → "Queue" in the tab button text and empty-state copy
- `view === 'saved'` conditions unchanged (internal value stays `'saved'`)

Session-local progress state (in `App` component):
```
const [initialQueueCount, setInitialQueueCount] = useState(0);
```
- Set to `savedArticles.length` when `view` transitions to `'saved'`
- Reset each time the Queue tab is entered (not on subsequent re-renders)

Queue tab header additions (rendered only when `view === 'saved'`):
- Progress bar: `(initialQueueCount - savedArticles.length) of initialQueueCount read` — hidden when `initialQueueCount === 0`
- "Clear all" button: visible when `savedArticles.length > 0`

Done state (when `view === 'saved'` and `savedArticles.length === 0` and prefs ready):
- Replace generic "No saved articles yet" with "Queue cleared ✓" (or equivalent)

### Module: `App.css`

New styles:
- `.queue-header` — flex row containing progress bar and clear-all button
- `.queue-progress` — thin progress bar (reuse feed-end visual language)
- `.btn-clear-queue` — destructive-ish button (not red, but visually lighter than a primary action)
- `.queue-done` — done-state empty message (slightly celebratory, not just informational)

### No schema changes

`UserPrefs` already has `savedIds`, `savedAtById`, `unsavedAtById`. No new fields required.

### No type changes

`FeedView = 'feed' | 'saved' | 'rec'` stays unchanged.

## Testing Decisions

**`storage.node.test.ts`** — test `clearQueue`:
- Clears `savedIds` and `savedAtById`
- Records all cleared IDs in `unsavedAtById` with current timestamp
- Preserves existing `unsavedAtById` entries for previously-cleared IDs
- Is a no-op when `savedIds` is already empty

**`useFeed.ts` auto-dequeue behavior** — covered by the `storage` unit tests on `toggleSaved` (already tested). The integration point (`handleOpen` calling `toggleSaved`) is logic-tested via the storage layer; no new hook-level test file is needed for this slice.

Prior art: `storage.node.test.ts` already has patterns for testing pure prefs-transform functions (`toggleSaved`, `markRead`, `upvote`, etc.) — follow the same shape.

## Out of Scope

- Article search / filter by saved or previously saved (see `docs/article-search/design.md`)
- Queue size cap or auto-expiry of stale saves
- Swipe-to-dismiss or scroll-lock navigation
- Confirmation dialog before mass clear
- Rec backend signal for mass clear (mass clear is a UI hygiene action, not a preference signal)
