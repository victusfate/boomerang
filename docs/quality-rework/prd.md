# PRD: Quality Rework

Source: `design.md` findings F-01..F-65, decisions D1–D11. This PRD maps fix classes to concrete changes. Deferred (per design): D5 tombstone redesign, F-63 file splits, F-34 ARIA tabs, F-47/F-48/F-52 product calls (per-isolate rate limiting strategy, pages.dev CORS pinning, sync GET auth).

## User Stories

| ID | Story | Findings |
|---|---|---|
| US-1 | As a user, search and history backfill actually work: my pre-existing reads are backfilled once prefs load, out-of-pool saved articles are searchable, and dequeuing them records history. | F-01, F-02, F-03 |
| US-2 | As a light-theme user, the search overlay renders correctly; pull-to-refresh doesn't fire under the overlay. | F-04, F-07 |
| US-3 | As a user, concurrent interactions never lose history/stats/title-cache writes. | F-05, F-21 |
| US-4 | As a user, the search overlay is efficient and robust: one remote fetch per open, no stale results, safe URLs, accessible results, non-negative progress. | F-06, F-08..F-12 |
| US-5 | As a user, the app never wedges in loading, never double-fetches, never double-writes prefs, honors server backoff, and never duplicates AI tags. | F-15..F-20 |
| US-6 | As a user, Settings doesn't steal focus while I type; dragging to refresh doesn't lag; score badges work by touch/keyboard; timers don't leak. | F-27..F-30, F-32, F-33 |
| US-7 | As an operator, the worker resists abuse: capped fan-outs, atomic conditional writes, complete room deletion, validated redirects, CORS-clean caches, bounded bodies. | F-38, F-39, F-41, F-42, F-49, F-50, F-51, F-54 |
| US-8 | As a WS client, tags submitted over HTTP reach me; MetaDO survives hibernation; one writer owns `meta:<id>`. | F-37, F-40, F-45, F-53 |
| US-9 | As a reader, topics aren't mis-tagged by substring keywords; interactions aren't silently dropped. | F-43, F-44 |
| US-10 | As a maintainer, dead code is gone and shared helpers exist once. | F-55..F-60, F-64 |
| US-11 | As a user on a large pool, ranking/dedup/render hot paths don't burn CPU. | F-61, F-62, F-65, F-28, F-29 |
| US-12 | As a maintainer, sync merge respects caps; OPML round-trips preserve source identity; the route registry matches reality. | F-14, F-24, F-60 |

## Implementation Decisions

- **F-01**: `useHistoryBackfill(prefs, url, ready)` — effect keyed on `ready` (from `useFeed.syncReady`), runs once when ready flips true. IndexedDB flag remains the idempotence guard.
- **F-02**: extract `buildCandidates` into `articleSearch.ts` (pure, tested); include `savedArticles` entries not in pool with `inPool: true, inQueue: true` (they are openable via `onOpen`).
- **F-03**: dequeue history writes resolve articles from pool ref, then saved-articles ref fallback.
- **F-05**: `articleHistory` rewrites: `put(entry)` upsert; eviction sweep only when `count > HISTORY_STORE_MAX` deletes oldest by `interactedAt`. Pure helpers stay for tests.
- **F-06/F-08**: SearchOverlay fetches remote candidates once on mount (when `!backfilled`), AbortController on unmount; Tier 2 debounce deleted — all filtering is local at 150ms.
- **F-12/F-58**: new `services/timeAgo.ts` with `timeAgo(date, style: 'short'|'ago')`; replaces 4 copies. New `services/base64.ts` for the 3 byte-loop copies. `parseRetryAfterMs` moves to a shared http util.
- **F-15**: cache-load always clears loading; `lastRefresh` only set when cache yields visible articles.
- **F-16**: fetch token: `finally` clears `fetchingRef` only if its token is still current.
- **F-17**: compute next prefs outside updaters or persist via post-update effect — no kvSet inside updaters.
- **F-19**: module-level in-flight flag per tagging pass; `onTagged` dedupes by articleId.
- **F-27**: Settings keeps `onClose` in a ref; focus-trap effect deps `[]`.
- **F-28**: pull indicator driven by direct DOM style via ref from gesture handlers; `pullProgress` state removed.
- **F-29**: `useMemo` Map id→FeedScoreInsight over filtered articles + rec inputs.
- **F-37**: MetaDO: `serializeAttachment({ subscribedIds })` on subscribe; lazily rehydrate `sessions` from `state.getWebSockets()` when the Map is empty/missing a socket.
- **F-40/F-45**: `POST /meta/tags` forwards to MetaDO (new DO route) so DO is sole writer of `meta:<id>`; `upsertMetaEntry` deleted.
- **F-41**: R2 `put(..., { onlyIf: { etagMatches } })`, drop head-then-put.
- **F-42**: `deleteRoom` loops `list({ cursor })` until done.
- **F-49**: og-image/image: manual redirect loop (≤3 hops, re-validate each), `AbortSignal.timeout`.
- **F-43**: `detectTopics` uses word-boundary regexes compiled once per keyword set.
- **F-55/F-56**: delete dead exports + their tests where the only callers are tests of the dead code; verify by grep before each deletion.
- **F-57/F-62**: one `selectSavedArticles(prefs, pool, importedSaves)` selector used by `useFeed` (memoized) and `useFeedPortability`.
- **F-61**: precompute word-sets per article before pairwise similarity.

## Testing Decisions

Risky fixes requiring new/updated tests (node runner): F-02 (buildCandidates), F-05 (eviction sweep pure logic), F-13-deferred—n/a, F-14 (mergePrefs caps), F-43 (detectTopics fixtures), F-57 (selector), F-61 (dedupe equivalence on fixture titles), F-24 (OPML round-trip). Hook/component fixes (F-15..F-20, F-27..F-33) are verified by typecheck + full suite + Playwright smoke (extended where feasible). Worker fixes verified against wrangler dev with curl where the harness allows (caps, 400s, redirect guard).
