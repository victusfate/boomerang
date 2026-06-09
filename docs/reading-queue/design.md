# Design: Reading Queue

## Canonical Vocabulary

| Term | Definition |
|---|---|
| **Queue** | The renamed "Saved" tab — a bounded, completable reading list |
| **Enqueue** | Add an article to the Queue (tap ☆ → ★); previously called "save" |
| **Dequeue** | Auto-remove an article from the Queue when it is opened |
| **Mass clear** | Button that removes all remaining articles from the Queue at once |
| **Queue progress** | Session-local counter: articles opened ÷ initial queue size when the tab was entered |
| **Done state** | Empty-queue UI shown when `savedIds.length === 0` |
| **Previously saved** | Articles whose ID appears in `unsavedAtById` but not `savedIds` — already tracked, enables future search |
| **Session-local** | State held only in React component memory for the duration of a single Queue-tab visit; not persisted to `UserPrefs` or synced |

---

## Problem

Users save articles with good intent but never return to them. The pile grows, guilt accumulates, and the release valve is bulk-unsaving everything. The "Saved" label implies a permanent archive; the desired mental model is an inbox: bounded, completable, self-clearing.

---

## Decisions

### D1 — Rename tab: "Saved" → "Queue"
**Rationale:** "Queue" connotes forward-motion and completion; "Saved" connotes permanence.  
**Alternatives considered:** "Reading List" (too long), "Later" (too vague).

### D2 — Auto-dequeue on open
Opening an article that is currently in the Queue (i.e., its ID is in `savedIds`) removes it from the Queue automatically — regardless of whether it is opened from the Queue tab or the Feed tab.  
**Rationale:** If you opened it, you read it (or decided not to). No need for a separate "mark done" action.  
**Mechanism:** `handleOpen` in `useFeed.ts` calls `toggleSaved` when the article is currently saved, after calling `markRead`.  
**Edge case:** Opening a non-saved article from the Feed does nothing to the Queue (no change in behavior).

### D3 — Star button remains as manual enqueue/dequeue
The ☆/★ button on each card still works as today. It is the only explicit way to add to the Queue. It also remains as a manual remove (unstar from Queue tab).  
**Rationale:** Consistent with existing mental model. The auto-dequeue (D2) is additive, not a replacement.

### D4 — Queue UI: progress list (not swipe, not locked scroll)
Existing card list, unchanged layout. Additions:
- Progress bar/counter at the top of the Queue tab: `X of Y read` (session-local, resets when Queue tab is entered)
- Mass clear button visible whenever `savedIds.length > 0`
- Done state (`savedIds.length === 0`): celebratory empty-state message  
**Rationale:** Smallest diff, reuses existing ArticleCard, works on desktop. Swipe/lock-scroll rejected as over-engineered for this slice.

### D5 — Session-local progress counter
When the user enters the Queue tab, record `initialQueueCount = savedIds.length` in component state. Progress shows `(initialQueueCount - savedIds.length) / initialQueueCount`. Resets each time the tab is entered.  
**Rationale:** No persistence needed. Avoids stale counts across sessions.

### D6 — Mass clear removes all savedIds
A single "Clear all" button sets `savedIds = []`, `savedAtById = {}`, and records all cleared IDs in `unsavedAtById` with the current timestamp.  
**Rationale:** Mirrors the user's existing behavior (bulk-unstar) but surfaces it as a first-class action instead of a chore.

### D7 — Tab label: `view` value stays `'saved'` internally
The internal `view` state string remains `'saved'` to avoid a large rename cascade. Only display strings change to "Queue".  
**Rationale:** Minimum viable diff; no behavior change in routing or sync logic.

---

## Edge Cases

| Scenario | Behavior |
|---|---|
| Open a saved article from Feed tab | Auto-dequeued (removed from savedIds) |
| Open an article that is not saved, from Feed tab | No change to Queue |
| Queue tab entered with 0 articles | Show done state immediately; no progress bar |
| Mass clear pressed | All savedIds cleared, all IDs timestamped in unsavedAtById |
| Sync merges remote savedIds while Queue tab is open | initialQueueCount not updated (session snapshot); progress bar may show > 100% cleared if remote adds items — acceptable edge case |

---

## Out of Scope (this slice)

- Article search / filter by saved or previously saved (see `docs/article-search/design.md`)
- Swipe-to-dismiss or scroll-lock queue navigation
- Queue size cap / auto-expiry of old saves
- Per-article "done" checkmark (auto-dequeue on open covers this)
