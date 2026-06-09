# PRD: Article Search

## Background

The Reading Queue auto-dequeues articles on open, which is the right UX for managing reading debt — but it makes previously-read or dequeued articles invisible. Users lose the ability to find something they engaged with. Search closes this gap: a single overlay lets users search everything they've seen, queued, or read, regardless of when.

## Goals

1. Let users search articles they've interacted with (read or queued) even after auto-dequeue removes them from the Queue.
2. Surface current feed and queue articles alongside historical ones so search is a single entry point for all content.
3. Be fast — local results at ~150ms; no perceptible lag on typical queries.
4. Preserve existing tab structure and routing; search is a transient overlay, not a new tab.

## User Stories

| ID | Story |
|---|---|
| US-1 | As a user, I tap the 🔍 icon in the header and a full-screen search overlay opens. |
| US-2 | As I type, results appear within ~150ms drawn from the current RSS pool and my local history store. |
| US-3 | I can filter results to Feed, Queue, or History using pill chips below the search input. |
| US-4 | Tapping a result opens the article (same behaviour as an ArticleCard open). |
| US-5 | On first launch after the feature ships, my existing read history is silently backfilled in the background. |
| US-6 | Every article I open or dequeue is recorded in my local history so future searches find it. |

## Functional Requirements

### FR-1 — Entry point
- A `🔍` icon button in the header (`app-header header-right`) opens the search overlay.
- Overlay dismissed by tapping outside, pressing Escape, or tapping a close button.
- `showSearch: boolean` state in `App.tsx`; `FeedView` is not modified.

### FR-2 — Interaction history store
New IndexedDB key `article-history:v1` (managed by `articleHistory.ts`):

```ts
interface HistoryEntry {
  id: string;
  title: string;
  url: string;
  source: string;
  sourceId: string;
  publishedAt: string;   // ISO string
  interactedAt: number;  // epoch ms
}
```

- **Written** on `handleOpen` (read event) and on any dequeue event (`toggleSaved` when removing, `clearQueue`).
- **Cap**: 500 entries (`HISTORY_STORE_MAX = 500`). On overflow, evict the entry with the oldest `interactedAt`.
- Eviction is synchronous with each write.

### FR-3 — History backfill
On first app load after the feature ships (detected by absence of `article-history:backfilled` key in IndexedDB):

1. Collect all IDs from `prefs.readIds` + `Object.keys(prefs.unsavedAtById ?? {})`.
2. Deduplicate, cap at 500 IDs (most recent `unsavedAtById` entries win over `readIds`).
3. POST to `/rec/articles` — single request, up to 500 IDs.
4. Write resolved articles to history store (respecting 500-entry cap).
5. Set `article-history:backfilled` in IndexedDB to prevent re-run.

Runs in a `useEffect` background task; does not block the UI.

### FR-4 — Search corpus and matching
On every query:
- **Tier 1 (~150ms debounce):** filter `allArticles` + `savedArticles` (sync) and read from IndexedDB history store.
- **Tier 2 (~400ms debounce):** only active during the backfill window (before `article-history:backfilled` is set); calls `/rec/articles` to resolve remote IDs.

Match logic (title + source, case-insensitive):
1. Prefix match on title
2. Word-prefix match on any word in title
3. Substring match anywhere in title or source

Ordering: match rank (1 > 2 > 3), then `publishedAt` descending within each rank. Tier 2 results append below Tier 1.

Empty query → show empty state: "Search your feed and reading history."

### FR-5 — Filter chips
Four pills below search input reusing `.topic-pill` / `.topic-pill.active` CSS:

| Chip | Source |
|---|---|
| All | Merged across all three sources |
| Feed | `allArticles` only |
| Queue | `savedArticles` only |
| History | History store only (IDs not in current pool) |

Chip state is local to the overlay; resets when overlay closes.

### FR-6 — Result card shape
- **In-pool results** (Feed / Queue): reuse `ArticleCard` with `onOpen` wired to `handleOpen`; no score badge, no vote buttons.
- **History-only results**: lighter card showing title, source, and formatted `publishedAt`. Tapping opens URL directly (no pool context).

### FR-7 — Search icon in header
- Renders as a `🔍` icon button (`icon-btn`) in `header-right`, before the refresh button.
- `aria-label="Search"`.

## Non-Functional Requirements

- History store reads ≤5ms at 500 entries.
- Overlay open animation ≤100ms.
- No changes to `FeedView` type or tab routing.
- History store cap `HISTORY_STORE_MAX = 500` is extracted as a named constant (future paid tier hook).

## Edge Cases

| Scenario | Behavior |
|---|---|
| Article in history store and current RSS pool | Pool result takes precedence; shown under Feed/Queue chip, not History |
| History not yet backfilled, user searches immediately | Tier 1 pool results at 150ms; Tier 2 resolves remaining remotely at 400ms |
| `/rec/articles` returns `missing` IDs during backfill | Skip silently |
| User opens overlay with empty query | Empty state: "Search your feed and reading history." |
| Query matches nothing | "No results for [query]." |
| 500-entry cap hit during backfill | Most recent `interactedAt` entries win; oldest dropped |
| `PLATFORM_WORKER_URL` not set | Tier 2 disabled; Tier 1 still works |

## Out of Scope

- Unlimited history (future paid tier)
- Full-text body search
- Cross-device history sync
- Server-side search index
