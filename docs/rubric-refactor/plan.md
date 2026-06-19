# Plan: Rubric Refactor — Structural 10/10 Pass

Branch: `claude/custom-news-feed-app-NcrzS`. Commit per slice. Gate after each:
`tsc --noEmit` + `npm test` in `news-feed/`.

Audit baseline (2026-06-18): worst files `useFeed.ts` (3/3/4/4), `App.tsx` (5/4/4/6),
`useSyncWorker.ts` (6/5/7/6), `Settings.tsx` (6/5/7/8).

---

## Slices

### S1 — Named-constant sweep (services + hooks)
**Scope:** All magic numbers and bare string keys extracted to named constants.
No behavior change. One commit per file group.

Files:
- `services/algorithm.ts` — 6 bare floats (tier penalty, recency, dedup threshold)
- `services/storage.ts` — 8 weight floats (upvote/downvote increments) + 3 pool-size caps
- `services/adFilter.ts` — scoring weights + `isAd` threshold
- `services/newsService.ts` — 4 timeout constants + bundle-size caps
- `services/labelSuggester.ts` — TTL, min-length, boost threshold
- `services/articleHistory.ts` — IDB sweep cap
- `services/syncShare.ts` — no new constants needed (reviewed clean)
- `hooks/useOGImageBatch.ts` — cache TTL, default batch size, fetch timeout, rootMargin
- `hooks/useAiTagging.ts` — poll interval, session timeout, string literal `'AI Tags'`
- `hooks/useMetaWorker.ts` — all interval/backoff/batch constants (already named; verify units documented)
- `hooks/useRecWorker.ts` — flush interval, batch size, debounce, poll interval

Findings fixed: bare literals throughout.

---

### S2 — storage.ts DRY: unify upvote/downvote
**Scope:** `services/storage.ts`

`upvote` and `downvote` are near-identical with opposite signs. Extract
`applyVote(direction: 'up' | 'down', article, prefs): UserPrefs` and have both
functions delegate to it. Add unit test covering weight symmetry.

---

### S3 — useFeed.ts: extract usePrefs
**Scope:** `hooks/useFeed.ts` → new `hooks/usePrefs.ts`

Move prefs lifecycle: load from kvStore, `updatePrefs`, `onToggleSource`,
`onToggleTopic`, `onToggleAiBar`, `onToggleTheme`, `onResetPrefs`, `onClearViewed`,
`onAddLabel`, `onDeleteLabel`, `onRenameLabel`. Returns `{ prefs, updatePrefs, ...handlers, prefsReady }`.

`useFeed` receives `usePrefs()` and passes `prefs`/`updatePrefs` down. File drops
~150 lines.

---

### S4 — useFeed.ts: extract useArticlePool
**Scope:** `hooks/useFeed.ts` → new `hooks/useArticlePool.ts`

Move article fetch/refresh/dedup/pagination: `refresh`, `handleLoadMore`, `articlePool`,
`allArticles`, `visibleArticles`, `hasMore`, `totalLoaded`, `loading`, `refreshing`,
`fetching`, `error`, `lastRefresh`, `feedEnterIds`, `fetchIdRef`. Accepts
`prefsRef`, `recArticleIds`, `recStatus`, `recBootstrapDone`, `recBootstrapError`,
`recCandidateMode`, `onArticlePoolIds`. Returns the full article state surface.

File drops ~200 lines.

---

### S5 — useFeed.ts: extract useInteractionHandlers
**Scope:** `hooks/useFeed.ts` → new `hooks/useInteractionHandlers.ts`

Move: `onOpen`, `onSave`, `onSaveExternal`, `onClearQueue`, `onUpvote`, `onDownvote`,
`onSeen`. Each handler calls `updatePrefs`, `recInteract`, and optionally
`writeHistoryEntry`. Accepts `prefsRef`, `allArticlesRef`, `savedArticlesRef`,
`updatePrefs`, `recInteract`.

`useFeed` becomes a thin orchestrator (~200 lines) wiring `usePrefs`, `useArticlePool`,
`useInteractionHandlers`, `useAiTagging`, `useFeedPortability`.

---

### S6 — App.tsx: five hook extractions
**Scope:** `App.tsx` → five new hooks in `hooks/`

Extract in one slice (all are small, non-overlapping):

| New hook | Absorbs | Est. lines |
|---|---|---|
| `usePullToRefresh(onRefresh, locked)` | touch gesture state, DOM writes, event listeners | 55 |
| `useInfiniteScrollSentinel(onLoadMore, view, totalLoaded, hasMore)` | both IO effects + manual trigger | 40 |
| `useVisibilitySync(forceMetaSync, forceSync, syncActive, syncReady)` | visibilitychange + initial sync one-shot | 30 |
| `useTitleCache(allArticles, savedArticles)` | load/save/memo/getArticleTitle | 25 |
| `useSourceNameLookup(allArticles, savedArticles)` | memo + getSourceName callback | 15 |

`App.tsx` drops from 701 → ~200 lines.

---

### S7 — Fix forceMetaSync instability in useMetaWorker
**Scope:** `hooks/useMetaWorker.ts`, `App.tsx`

`forceMetaSync` is currently recreated on every 500ms cooldown tick, forcing the
`forceMetaSyncRef` workaround in App.tsx. Fix: stabilise `forceMetaSync` via
`useCallback` with a stable internal ref so cooldown ticks don't change its identity.
Remove the `forceMetaSyncRef` workaround from App.tsx and use `forceMetaSync` directly
in `useVisibilitySync`.

---

### S8 — Settings.tsx: decompose into section components
**Scope:** `components/Settings.tsx` → five new components

Extract:
- `SyncSection` — device sync UI, link generation, revoke
- `SourcesSection` — source toggles, custom source add/remove, OPML import/export
- `LabelsSection` — user label CRUD, bookmark import/export
- `AISection` — AI bar toggle, label suggestions
- `PreferencesSection` — topic toggles, theme, reset, clear viewed

`Settings.tsx` becomes a shell that renders the five sections. Props interface
shrinks to per-section option objects. File drops from 644 → ~100 lines.

---

### S9 — RecDiagnostics.tsx: decompose
**Scope:** `components/RecDiagnostics.tsx` → three new components

Extract:
- `RecScoreTable` — scored article rows with source/title lookup
- `RecModelInfo` — candidate mode, diagnostics, cache info, timing
- `RecTraceView` — trace log rendering

`RecDiagnostics.tsx` drops from 614 → ~100 lines. Replace magic color strings with
CSS variables or named constants.

---

### S10 — ArticleCard.tsx: decompose
**Scope:** `components/ArticleCard.tsx` → two new components + one hook

Extract:
- `useArticleDwell(onSeen, articleId)` — IntersectionObserver + timer logic
- `TagEditor` (inline component) — tag input, key handler, add/remove
- `DownvotedCard` — the separate downvoted render path (eliminates duplication)

Name `DWELL_MS` constant. Props interface trimmed by grouping into
`{ article, prefs, handlers, scoring }`.

---

### S11 — useSyncWorker.ts: extract useSyncRoom
**Scope:** `hooks/useSyncWorker.ts` → new `hooks/useSyncRoom.ts`

Move room lifecycle: load from storage/fragment, `activate`, `generateLink`, `revoke`,
`saveSyncRoom`, `clearSyncRoom`, migration of legacy rooms. Returns
`{ room, activate, generateLink, revoke }`.

`useSyncWorker` retains poll/push/conflict/rate-limit/cooldown logic and shrinks
from 559 → ~300 lines. `useSyncRoom` is ~120 lines.

---

### S12 — labelClassifier.ts: extract diagnostic logging
**Scope:** `services/labelClassifier.ts`

Move `logPromptApiDiagnostics` and its 20-line setup block out of the main
classification flow into a `services/labelClassifierDiagnostics.ts` module.
`classifyArticle` calls it only when the debug flag is set.

---

### S13 — newsService.ts: structural fixes
**Scope:** `services/newsService.ts`

- Extract `isYoutubeSourceId` to `services/sourceUtils.ts` (used in two places)
- Flatten the 7-level nesting in `loadArticlesFromWorker` using `Promise.allSettled`
  and explicit error collection instead of nested `.catch` silencing
- Document the binary-encoding loop or replace with `TextEncoder`

---

### S14 — Remaining minor fixes
**Scope:** miscellaneous across all files

- `services/recWorker.ts` — document or fix fragile ETag key construction
- `services/articleHistory.ts` — flatten `putAndSweep` IDB callback pyramid
  using async/await
- `config/debugSync.ts` — remove `TRUE_VALUES` indirection (just check directly)
- `hooks/useAiTagging.ts` — remove validation theater in `onModelStatus`
- `services/kvStore.ts` — document multi-tab behavior of module-level `dbPromise`

---

## Target Scores (post-refactor)

| File | Q | R | E | C |
|---|---|---|---|---|
| `hooks/useFeed.ts` | 10 | 10 | 10 | 10 |
| `App.tsx` | 10 | 10 | 10 | 10 |
| `hooks/useSyncWorker.ts` | 9 | 9 | 9 | 9 |
| `components/Settings.tsx` | 10 | 10 | 10 | 10 |
| `components/RecDiagnostics.tsx` | 10 | 10 | 10 | 10 |
| `components/ArticleCard.tsx` | 10 | 10 | 10 | 10 |
| All other files | 9–10 | 9–10 | 9–10 | 9–10 |
