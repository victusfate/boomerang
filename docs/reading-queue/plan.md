# Plan: Reading Queue

Each slice cuts through data → logic → UI → tests.

---

## Slice 1 — `clearQueue` pure function

**Behavior:** `clearQueue(prefs)` zeros `savedIds`/`savedAtById` and bulk-writes all cleared IDs to `unsavedAtById`.

- Add `clearQueue` to `services/storage.ts`
- Tests in `storage.node.test.ts`

---

## Slice 2 — Auto-dequeue on open

**Behavior:** Opening a saved article (from any tab) removes it from the Queue.

- Modify `handleOpen` in `hooks/useFeed.ts` to call `toggleSaved` when article is currently saved
- Add `onClearQueue` handler + export from `useFeed`
- Behavior covered by existing `toggleSaved` tests; integration verified manually

---

## Slice 3 — Queue tab UI (rename + mass clear + done state)

**Behavior:** Tab label is "Queue"; "Clear all" button appears when queue is non-empty; done state shows when queue is empty.

- Update tab label and empty-state copy in `App.tsx`
- Wire `onClearQueue` into the Queue tab header
- Add styles to `App.css`

---

## Slice 4 — Session-local progress counter

**Behavior:** Entering the Queue tab records the initial count; a `X of Y read` indicator tracks progress during the visit.

- Add `initialQueueCount` state and `useEffect` on `view` in `App.tsx`
- Render progress bar in Queue tab header
- Add `.queue-progress` styles to `App.css`
