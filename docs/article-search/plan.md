# Implementation Plan: Article Search

Each slice cuts through all layers (data → logic → UI → tests). Execute RED → GREEN → REFACTOR.

---

## Slice 1 — History store service (`articleHistory.ts`)

**Scope:** Pure IndexedDB service. No React, no network.

**Files:**
- `news-feed/src/services/articleHistory.ts` ← new
- `news-feed/src/services/articleHistory.node.test.ts` ← new

**Behaviour to test:**
- `writeHistoryEntry` stores an entry and can be read back.
- Writing 501 entries evicts the oldest by `interactedAt`, keeping exactly 500.
- `readHistoryEntries` returns all entries sorted by `interactedAt` descending.
- Writing the same `id` twice updates `interactedAt` (upsert semantics).
- `isBackfilled()` returns false before `markBackfilled()`, true after.
- `markBackfilled()` is idempotent.

**Exports:**
```ts
export const HISTORY_STORE_MAX = 500;
export interface HistoryEntry { id, title, url, source, sourceId, publishedAt, interactedAt }
export function writeHistoryEntry(entry: HistoryEntry): Promise<void>
export function readHistoryEntries(): Promise<HistoryEntry[]>
export function isBackfilled(): Promise<boolean>
export function markBackfilled(): Promise<void>
// test helpers
export function resetHistoryStoreForTest(): Promise<void>
```

**Notes:**
- Use `idb` (already in package.json if present) or raw IndexedDB via a thin promise wrapper.
- Two object stores in the DB: `entries` (keyPath: `id`) and `meta` (keyPath: `key`).
- Check `idb` availability: `grep "idb" news-feed/package.json`.

---

## Slice 2 — Write triggers in `useFeed` + `handleClearQueue`

**Scope:** Wire `writeHistoryEntry` into existing interaction handlers.

**Files:**
- `news-feed/src/hooks/useFeed.ts` ← modify `handleOpen`, `handleSave` (dequeue branch), `handleClearQueue`

**Behaviour:**
- `handleOpen` → writes `HistoryEntry` with `interactedAt = Date.now()` (fire-and-forget, no await in render path).
- `handleSave` when toggling OFF (dequeue) → writes entry.
- `handleClearQueue` → writes entry for every dequeued ID (batch write).
- Entries use `Article` fields directly (id, title, url, source, sourceId, `publishedAt.toISOString()`).

**Test:** Integration is exercised by Slice 1 unit tests + the Playwright smoke test at the end. No new unit tests for this slice (side effects require a browser IndexedDB).

---

## Slice 3 — Search logic (`articleSearch.ts`)

**Scope:** Pure function — no React, no IndexedDB, no network. Takes arrays in, returns ranked results.

**Files:**
- `news-feed/src/services/articleSearch.ts` ← new
- `news-feed/src/services/articleSearch.node.test.ts` ← new

**Behaviour to test:**
- Prefix match ranks above word-prefix match, which ranks above substring match.
- Within the same rank tier, results sort by `publishedAt` descending.
- Case-insensitive matching.
- Empty query → returns empty array.
- Deduplication: if same `id` appears in pool and history, pool entry wins.
- Filter by scope: `'feed'`, `'queue'`, `'history'`, `'all'`.

**Exports:**
```ts
export type SearchScope = 'all' | 'feed' | 'queue' | 'history';

export interface SearchCandidate {
  id: string;
  title: string;
  url: string;
  source: string;
  sourceId: string;
  publishedAt: string;  // ISO string
  inPool: boolean;
  inQueue: boolean;
}

export function searchArticles(
  query: string,
  candidates: SearchCandidate[],
  scope: SearchScope,
): SearchCandidate[]
```

**Notes:**
- Pool articles have `inPool: true`; queue articles have `inPool: true, inQueue: true`; history-only have `inPool: false, inQueue: false`.
- `'history'` scope filters to `!inPool && !inQueue`.

---

## Slice 4 — `SearchOverlay` component

**Scope:** Self-contained overlay component. Wires Tier 1 debounce, filter chips, and result rendering.

**Files:**
- `news-feed/src/components/SearchOverlay.tsx` ← new
- `news-feed/src/App.css` ← add overlay styles

**Props:**
```ts
interface SearchOverlayProps {
  allArticles: Article[];
  savedArticles: Article[];
  onOpen: (article: Article) => void;
  onClose: () => void;
  platformWorkerUrl: string;  // for Tier 2; empty string = disabled
  backfilled: boolean;        // from history store; controls Tier 2 activation
}
```

**Behaviour:**
- Renders full-screen overlay with backdrop.
- `<input>` auto-focused on mount; Escape key calls `onClose`.
- Tap outside (backdrop click) calls `onClose`.
- Filter chips row: All / Feed / Queue / History, using `.topic-pill` CSS class.
- Tier 1: `useEffect` debounced at 150ms on query change — reads IndexedDB + filters pool synchronously.
- Tier 2: `useEffect` debounced at 400ms — only fires when `!backfilled` and `PLATFORM_WORKER_URL` is set; calls `POST /rec/articles`; appends results below Tier 1.
- Empty query → empty-state message.
- No results → "No results for [query]."
- In-pool result → `ArticleCard` variant (stripped: no score, no votes).
- History-only result → `HistoryCard` inline component (title, source, publishedAt, clickable to URL).

**CSS additions:**
```css
.search-overlay { position: fixed; inset: 0; z-index: 200; ... }
.search-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.5); }
.search-panel { position: relative; ... }
.search-input { ... }
.search-chips { display: flex; gap: 0.5rem; ... }
.history-card { ... }
```

---

## Slice 5 — History backfill hook (`useHistoryBackfill`)

**Scope:** One-time background migration on first app load.

**Files:**
- `news-feed/src/hooks/useHistoryBackfill.ts` ← new

**Behaviour:**
- On mount, call `isBackfilled()`.
- If false: collect `prefs.readIds` + `Object.keys(prefs.unsavedAtById ?? {})`, deduplicate, cap at 500.
- POST to `/rec/articles` (single request).
- For each returned article, call `writeHistoryEntry` with `interactedAt` from `unsavedAtById[id]` or `Date.now()` for read-only IDs.
- Call `markBackfilled()`.
- Updates local `backfilled` state used by `SearchOverlay` to suppress Tier 2.

**Exports:**
```ts
export function useHistoryBackfill(
  prefs: UserPrefs,
  platformWorkerUrl: string,
): { backfilled: boolean }
```

---

## Slice 6 — App.tsx integration

**Scope:** Wire everything together in `App.tsx`.

**Files:**
- `news-feed/src/App.tsx` ← add `showSearch` state, search icon button, `SearchOverlay` render, `useHistoryBackfill`

**Changes:**
1. Import `SearchOverlay`, `useHistoryBackfill`.
2. `const [showSearch, setShowSearch] = useState(false)`.
3. `const { backfilled } = useHistoryBackfill(prefs, PLATFORM_WORKER_URL)`.
4. Add `🔍` icon-btn in `header-right` before the refresh button: `onClick={() => setShowSearch(true)}`.
5. Render `{showSearch && <SearchOverlay ... onClose={() => setShowSearch(false)} />}` after the `</header>`.

---

## TDD Execution Order

```
Slice 1: articleHistory.ts       → RED tests → GREEN impl → REFACTOR
Slice 2: useFeed write triggers  → GREEN (no new unit tests; verified via Playwright)
Slice 3: articleSearch.ts        → RED tests → GREEN impl → REFACTOR
Slice 4: SearchOverlay.tsx       → GREEN impl → visual verify
Slice 5: useHistoryBackfill.ts   → GREEN impl (network mock via msw or inline)
Slice 6: App.tsx wiring          → GREEN impl → Playwright smoke test
```
