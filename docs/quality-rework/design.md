# Design: Quality Rework — Full-Codebase Audit

Audit date: 2026-06-09, branch `claude/custom-news-feed-app-NcrzS` (includes PR #66).
Sources: PR #66 diff review `[review]`, whole-codebase structural review `[quality]`, simplification pass `[simplify]`. Three parallel reviewers covered services+hooks, UI layer, and platform-worker+shared.

## Canonical Vocabulary

| Term | Definition |
|---|---|
| **Out-of-pool saved article** | An article in `savedArticles` that is not in `allArticles` — comes from `importedSaves` or aged out of the RSS pool. Several features silently miss these. |
| **Impure updater** | A `setState(prev => …)` callback that performs side effects (e.g. `kvSet`). React may re-invoke updaters (StrictMode/concurrent), double-firing the effect. |
| **Per-isolate state** | In-memory module state in the Cloudflare Worker (rate-limit Maps, mem caches) that silently resets per isolate and diverges across PoPs. |
| **Tombstone** | A deletion marker that lets a removal propagate through set-union sync merges. Only `unsavedAtById` has one today; all other prefs sets resurrect deletions. |
| **Hibernation rehydration** | Restoring WebSocket session state via `state.getWebSockets()` + `serializeAttachment` after a Durable Object hibernates. MetaDO skips this. |
| **Write-path gap** | An interaction that should write a `HistoryEntry` but doesn't, leaving search history incomplete. |

## Findings

Severity: **C** critical (feature broken) · **H** high (user-visible damage) · **M** medium · **L** low. `[u]` = uncertain.

### A. Article Search / Reading Queue (PR #66 — fix before merge)

| ID | Source | File | Finding | Sev |
|---|---|---|---|---|
| F-01 | [review] | `hooks/useHistoryBackfill.ts:81` | Backfill runs on mount before prefs hydrate (prefs = `DEFAULT_PREFS`), finds 0 IDs, marks backfilled permanently — real history never backfills. Gate on `prefsReady`/`syncReady`. | C |
| F-02 | [review] | `components/SearchOverlay.tsx:40` | `buildCandidates` builds only from `allArticles`; out-of-pool saved articles never become search candidates — Queue chip misses them. | C |
| F-03 | [review] | `hooks/useFeed.ts:604,631` | `handleClearQueue`/`handleSave` (unstar) resolve articles only from `allArticlesRef` — out-of-pool saves get no history entry on dequeue (write-path gap). | H |
| F-04 | [review] | `App.css` (overlay block) | Overlay uses undefined `--card-bg`/`--hover-bg` vars (theme defines `--card`, no hover var) — dark-on-dark panel in light mode. | H |
| F-05 | [review] | `services/articleHistory.ts:59` | `writeHistoryEntry` does read-all → `clear()` → rewrite-all: O(n) per open and lost-update race between concurrent fire-and-forget writes. Store is keyed by `id`; plain `put` + occasional eviction sweep fixes both. | M |
| F-06 | [review] | `components/SearchOverlay.tsx:118` | Tier 2 re-POSTs the same ≤500-ID body per debounced keystroke; response is query-independent — fetch once per mount, filter locally. | M |
| F-07 | [review] | `App.tsx:271` | Pull-to-refresh touch handlers stay armed while search overlay is open (only checks `showSettings`). | M |
| F-08 | [review] | `components/SearchOverlay.tsx:121` | Stale-response race: cleared debounce timer doesn't abort in-flight Tier 2 fetch; old response can land filtered by stale query. | L |
| F-09 | [review] | `App.tsx:482` | Queue progress counter goes negative if user stars a new article while on Queue tab. | L |
| F-10 | [review] | `components/SearchOverlay.tsx:160` | History-only results `window.open(c.url)` without `normalizeArticleNavUrl` — `&amp;` and non-http URLs open broken/unsafe. | L |
| F-11 | [quality] | `components/SearchOverlay.tsx:209` | `<button role="listitem">` overrides the button role — AT users not told results are actionable. | M |
| F-12 | [quality] | `components/SearchOverlay.tsx:25` | `timeAgoIso` duplicates `ArticleCard.timeAgo`; also `formatRelativeMinutes` (App) and `formatSyncedAt` (Settings) are two more copies of the same formatter. | L |

### B. Client state & sync correctness

| ID | Source | File | Finding | Sev |
|---|---|---|---|---|
| F-13 | [review] | `services/syncShare.ts:89` | `mergePrefs` set-unions all ID lists and `mergeById`s sources/labels — every removal (un-downvote, re-enable source, delete label) is resurrected by the next sync merge. Only `savedIds` has a tombstone. | H |
| F-14 | [review] | `services/syncShare.ts:92` | `mergePrefs` never applies `MAX_SEEN_IDS`/`MAX_READ_IDS` caps — cross-device unions grow without bound, inflating every kvSet and sync payload. | M |
| F-15 | [review] | `hooks/useFeed.ts:411` | Cache-load sets `setLoading(false)` only `if (ranked.length)` but sets `lastRefresh` unconditionally, and auto-fetch skips when `lastRefresh` is set — all-seen cache leaves app stuck loading, no fetch ever fires. | M |
| F-16 | [review] | `hooks/useFeed.ts:554` | Superseded fetch's `finally` clears `fetchingRef` while the newer fetch is in flight — concurrency guard broken, parallel refresh possible. | M |
| F-17 | [review] | `hooks/useFeed.ts:566,679,693,711` + `useAiTagging.ts:109` | `kvSet` inside `setState` updaters (impure updater) — double-writes under StrictMode/concurrent rendering. | M |
| F-18 | [review] | `hooks/useMetaWorker.ts:156` | `flush()` ignores `blockedUntilRef` — after a 429 the retry chain keeps POSTing every 20s, ignoring Retry-After; also splices the batch before the env guard, silently discarding tags. | M |
| F-19 | [review] | `hooks/useAiTagging.ts:66` | No in-flight guard: four call sites can schedule overlapping tagging passes; `onTagged` appends without per-article dedupe — duplicate ArticleTag rows accumulate in kv. | M |
| F-20 | [review] | `hooks/useOGImageBatch.ts:149` | `[u]` Sentinel effect re-runs per `fetchedUpTo` change and fresh observer fires immediately while sentinel visible — endless observe→setState loop on short lists. | M |
| F-21 | [review] | `services/recStats.ts:41` + `services/titleCache.ts:6` | Unserialized read-modify-write on single kv keys, fired per interaction/render — overlapping writes lose increments/entries. | L |
| F-22 | [review] | `hooks/useSyncWorker.ts:152` | `[u]` `disableLocalSyncRoom` saves the failed room back to localStorage — every app start re-activates the dead room and fires a guaranteed-401 poll. | L |
| F-23 | [review] | `services/syncShare.ts:54` | `savedAtById`/`unsavedAtById` merged with max() and never pruned — grow monotonically forever. | L |
| F-24 | [review] | `services/storage.ts:476` | OPML import regenerates custom-source ids and ignores disabled flags — round trip re-enables disabled feeds, orphans old ids in `disabledSourceIds`. | L |
| F-25 | [review] | `services/storage.ts:211` | `[u]` `applyDecay` decays topic and keyword weights but never `sourceWeights` — source preferences lock in forever. | L |
| F-26 | [review] | `services/adFilter.ts:29` | `[u]` utm params (+6) + one moderate keyword + listicle title cross the ≥10 ad threshold — legitimate articles silently filtered. | L |

### C. UI layer

| ID | Source | File | Finding | Sev |
|---|---|---|---|---|
| F-27 | [review] | `components/Settings.tsx:112` + `App.tsx:650` | Focus-trap effect depends on `onClose` (inline arrow in App) — re-runs on every App re-render while Settings is open, stealing focus from inputs mid-typing. Capture in a ref or memoize. | H |
| F-28 | [quality] | `App.tsx:289` | `setPullProgress` per touchmove frame re-renders the whole App (all cards + per-card insight computation) during drag — isolate the indicator or drive via CSS var/ref. | M |
| F-29 | [simplify] | `App.tsx:591` | `computeFeedScoreInsight` recomputed inline per card per render — precompute a memoized Map. | M |
| F-30 | [review] | `components/CardScoreBadge.tsx:98` | `role="button"` + `aria-expanded` with no click/key activation — AT told it's a button that does nothing; touch users can't open the popover. | M |
| F-31 | [review] | `components/RecDiagnostics.tsx:149` | Source-bar segment widths divide by net score (downvotes negative) — positive segments sum >100% and overflow the track. | L |
| F-32 | [review] | `components/Settings.tsx:137,153,181,196` | Uncleared `setTimeout`s (copy/import status) stack and fire after unmount; `handleSuggest` try/finally without catch swallows rejections with no user feedback. | L |
| F-33 | [review] | `components/ArticleCard.tsx:135` | Invalid `article.url` renders clickable anchors with `href=""` — left-click opens a blank tab; guard empty navUrl. | L |
| F-34 | [review] | `App.tsx:443` | Incomplete ARIA tabs pattern (no aria-controls/tabpanel/arrow keys). | L |
| F-35 | [review] | `App.tsx:357` | Label filter bidirectional substring match — label "AI" matches tag "rain". | L |
| F-36 | [review] | `components/RecDiagnostics.tsx:277` | `[u]` Late title lookup overwrites `lookupCoverage` from a newer batch (no staleness check). | L |

### D. Platform worker

| ID | Source | File | Finding | Sev |
|---|---|---|---|---|
| F-37 | [review] | `domains/meta/MetaDO.ts:26` | Hibernation API used but session state lives in in-memory Map — after hibernation, all messages from connected clients silently dropped, broadcasts empty. Rehydrate via `state.getWebSockets()` + `serializeAttachment`. (`webSocketOpen` is not a runtime callback and never fires.) | H |
| F-38 | [review] | `domains/rss/index.ts:39` | No cap on custom feeds and no rate limit on `/bundle` — caller can make the worker fetch hundreds of attacker-chosen URLs (×3 retries) per request with guaranteed cache miss. Cap (~20) + rate-limit. | M |
| F-39 | [review] | `domains/meta/index.ts:17,71` | `GET /meta` ids uncapped (unbounded parallel KV reads); `POST /meta/tags` uncapped, unauthenticated, unvalidated articleId becomes KV key — unlimited 180-day record creation and arbitrary tag overwrite. | M |
| F-40 | [review] | `domains/meta/index.ts:30` | HTTP tag writes skip MetaDO (no SQLite row, no broadcast) — POST tags invisible to WS subscribers; `upsertMetaEntry` duplicates `MetaDO.kvWrite` with drift. | M |
| F-41 | [review] | `domains/sync/index.ts:117` | If-Match is non-atomic head-then-put (TOCTOU) — concurrent PUTs both pass and last-write-wins. Use R2 `onlyIf: { etagMatches }`. | M |
| F-42 | [review] | `domains/sync/room.ts:25` | `deleteRoom` processes only the first `r2.list()` page — rooms >1000 blocks partially deleted, orphaned objects still billed. | M |
| F-43 | [review] | `domains/rss/parseFeed.ts:38` | `detectTopics` bare substring keywords ('un', 'ai', 'app') match inside ordinary words — mis-tags a large fraction of articles. Word-boundary regexes. | M |
| F-44 | [review] | `domains/rec/index.ts:209` | `POST /interactions` never checks the RecDO response status — returns `{ ok: true }` on DO 4xx/5xx, silently dropping events. | M |
| F-45 | [review] | `domains/rec/articleMetaKv.ts:110` | `persistArticleMeta` read-merge-write races `MetaDO.kvWrite`/`upsertMetaEntry` on the same `meta:<id>` key — stale tags resurrected (KV last-write-wins on whole record). | M |
| F-46 | [review] | `domains/rec/articleMetaKv.ts:64` | `[u]` 500 uncached POST ids → up to 1000 parallel KV gets (primary + legacy fallback) — brushes the 1000-subrequest cap before hydrate adds feed fetches. Parallelize the two gets per id or retire the legacy fallback. | M |
| F-47 | [review] | `domains/_shared/http.ts:5` | Rate limiting is per-isolate in-memory — resets on recycle, multiplies across isolates/PoPs; advisory only. | M |
| F-48 | [review] | `cors.ts:11` | `[u]` Any `https://*.pages.dev` origin allowed — any third party Pages site can call the full API from browsers. Pin to the project subdomain if previews-only. | M |
| F-49 | [review] | `domains/rss/index.ts:119` | `/og-image` and `/image` follow redirects without re-validating targets against the SSRF allowlist, contradicting the apiRoutes doc; also no fetch timeout (feeds get 25s). | M |
| F-50 | [review] | `domains/rss/index.ts:71` | Cached responses replay the original request's `Access-Control-Allow-Origin` even for disallowed origins — strip CORS headers around cache. | L |
| F-51 | [review] | `domains/sync/index.ts:67,124` | Unauthenticated GETs share the room's rate bucket (anyone with a roomId can exhaust the owner's quota); PUT bodies unbounded. | L |
| F-52 | [review] | `services/syncWorker.ts:129` + `domains/sync/index.ts:67` | `[u]` Sync meta GET requires no token on either side — anyone with the roomId reads the full prefs/saved-articles payload. Decide: by design (capability URL) or require token on GET. | L |
| F-53 | [review] | `domains/meta/MetaDO.ts:227` | `broadcast()` unguarded `ws.send` in loop — one closed socket aborts delivery to remaining subscribers. | L |
| F-54 | [review] | `index.ts:26,70` | `/health*` lacks CORS headers; `scheduledRec` unawaited in scheduled handler (sync throw → unhandled rejection). | L |

### E. Dead code & duplication

| ID | Source | File | Finding | Sev |
|---|---|---|---|---|
| F-55 | [quality] | `services/storage.ts:262` | ~115 lines of bookmark-payload export/import (`exportPrefsBookmark`, `importPrefsBookmark`, V1/V2 types, `parseBookmarkPrefs`, `mergePoolWithSavedSnapshots`) have no callers. | M |
| F-56 | [quality] | multiple | Dead code sweep: `newsService.fetchArticlesByIds` (also broken if revived), `metaWorker.ts` WS protocol surface (57-78), `labelClassifier.runClassificationPass`, `syncShare.mergeArticlesById`/`buildSyncShareUrl`, `topicFilterUtils.buildFilterState` (callers use one boolean), `ArticleCard.tagInputRef`, `MetaDO.ping()` heartbeat machinery, ~130 lines dead CSS (`.custom-source-*`, `.settings-field*`, `.bookmark-import-row`, `.rec-model-*`, etc.). | M |
| F-57 | [quality] | `hooks/useFeed.ts:856` + `useFeedPortability.ts:51` | Saved-articles assembly (sort by savedAt desc, then rank) duplicated wholesale — extract one shared selector. | M |
| F-58 | [quality] | multiple | Duplicated helpers: base64 byte-loop ×3 (`syncShare`, `storage`, `newsService`); `parseRetryAfterMs` ×2 (`syncWorker`, `metaWorker`); rate-limit helper duplicated in `sync/index.ts` vs `_shared/http.ts`; `ALL_TOPICS` (Settings) vs `SHOWN_TOPICS` (topicFilterUtils); sync-error `<details>` block ×2 in Settings; time-ago formatters ×4 (F-12). | M |
| F-59 | [quality] | `hooks/useFeed.ts:690` | Manual tag handlers re-implement trim/lowercase/dedupe inline instead of using `tagEditorUtils.addManualTag`/`removeManualTag` which exist solely for this. | L |
| F-60 | [quality] | `apiRoutes.ts` | Registry drift: `/health` shape, `customFeeds` "gzip" claim, `/sync/room` response shape, 409-vs-412, and missing `POST /rec/articles` entry — in a file claiming "single source of truth". | L |

### F. Performance & structure

| ID | Source | File | Finding | Sev |
|---|---|---|---|---|
| F-61 | [simplify] | `services/algorithm.ts:48` | Fuzzy dedupe re-splits/Set-ifies every accepted title per candidate (~60k builds per rankFeed, runs per progressive batch) — precompute one word-set per article. | M |
| F-62 | [quality] | `hooks/useFeed.ts:844` | `savedIds`/`savedRank`/`poolIds`/`savedById`/`savedArticles` rebuilt every render with no memo — and the hook re-renders on every seen-dwell prefs update. | M |
| F-63 | [quality] | file sizes | Oversized files: `useFeed.ts` 933, `App.tsx` 680, `Settings.tsx` 637, `RecDiagnostics.tsx` 601, `storage.ts` 569, `useSyncWorker.ts` 554 (all >400-line smell; storage shrinks via F-55 split/delete). | M |
| F-64 | [simplify] | `hooks/useSyncWorker.ts:214,423,446` | Debug-only JSON.stringify diffing on every poll; cooldown ticker in effect deps re-runs effect ~2×/sec to no-op. | L |
| F-65 | [simplify] | misc | `newsService` re-maps cumulative wire array per chunk; `fetchTier` linear find per article; `useRecHistoryReplay` O(n²) includes/some; `RecDiagnostics` render-body derivations; `articleMetaKv` sequential primary+legacy reads. | L |

## Decisions

Grouped by fix class — each class is one future vertical slice (or hotfix).

**D1 — Hotfix PR #66 before merge (F-01..F-04, F-07).** The two criticals and the dequeue write-path gap break the feature being shipped; the CSS var and pull-to-refresh gating are two-line fixes. These land on the current branch, not the quality PR. Everything else below targets a separate `quality-rework` branch after #66 merges.

**D2 — IndexedDB/kv write-path hardening (F-05, F-21).** Convert `articleHistory` writes to per-entry `put` upserts with an eviction sweep when `count > MAX`; serialize `recStats`/`titleCache` writes through a promise chain. Pure-helper tests already exist; add a race test via interleaved promises.

**D3 — Search overlay polish (F-06, F-08..F-12).** One-shot Tier 2 fetch cached per mount; AbortController; clamp progress counter at 0; normalize history URLs with the shared nav-URL helper; fix listitem role; extract one shared `timeAgo` helper (also resolves the App/Settings copies in F-58).

**D4 — React state discipline (F-15..F-20, F-27..F-30, F-32, F-33).** Move kvSet out of updaters; fix the fetch-lock and stuck-loading paths in useFeed; add in-flight guard + dedupe to AI tagging; honor backoff in metaWorker flush; memoize `onClose`/focus-trap deps; isolate pull-progress rendering; precompute insight map; make score badge activatable. Riskiest cluster — every fix here needs a regression test or explicit manual-test note.

**D5 — Sync merge semantics (F-13, F-14, F-22..F-24).** Architecturally significant: deletion propagation requires tombstones (per-field `removedAt` maps mirroring `unsavedAtById`) and a merge-version bump. Needs its own mini-design before implementation — **do not bundle into a mechanical fix slice**. Caps in `mergePrefs` and pruning of the At-maps are safe to do first.

**D6 — Worker abuse hardening (F-38, F-39, F-41, F-42, F-47..F-49, F-51).** Caps on `/bundle` custom feeds and `/meta` endpoints; atomic R2 conditional put; paginated room deletion; redirect re-validation + timeouts on image proxies; CORS cache hygiene; decide pages.dev pinning and rate-limit strategy (DO-based vs accept advisory) — the last two need a product call.

**D7 — MetaDO hibernation rework (F-37, F-40, F-45, F-53).** Rehydrate sessions from `state.getWebSockets()` with `serializeAttachment`; route HTTP tag writes through the DO so there is exactly one writer per `meta:<id>` key (also resolves the F-45 write race); guard broadcast sends. Self-contained, testable against the DO in wrangler dev.

**D8 — Dead code & duplication sweep (F-55..F-60, F-64).** Pure deletion + extraction, zero behavior change intended. Run the full test suite + Playwright smoke before/after; biggest single win for file-size findings (storage.ts loses ~115 lines).

**D9 — Performance pass (F-61, F-62, F-65, F-28, F-29).** Memoize derived collections, precompute dedupe word-sets, batch-map only new chunks. Verify with a before/after profile on a 350-article pool.

**D10 — Topic detection quality (F-43, F-26, F-35).** Word-boundary keyword matching in `parseFeed.detectTopics`; revisit adFilter utm weighting; exact-match label filtering. Changes ranking/tagging outputs — needs fixture-based tests with real titles.

**D11 — Docs and registry sync (F-60, F-54 doc half).** Mechanical; fold into D8.

**Deferred (out of this rework):** file splits beyond what D8 achieves naturally (F-63) — splitting `useFeed`/`App`/`Settings` is high-churn and should ride along future feature work in those areas, not happen as a standalone rewrite. Same for the full ARIA tabs pattern (F-34).

## Scope

**In:** D1 (on PR #66 branch immediately); D2–D4, D6–D11 on a `quality-rework` branch after #66 merges; D5 caps/pruning subset.
**Out:** D5 tombstone redesign (own design doc), F-63 file splits, F-34 ARIA tabs, paid-tier history, any feature work.

## Edge Cases the fixes must not break

- **Backfill idempotence:** F-01's fix (gate on `prefsReady`) must not re-trigger backfill on every prefs change — run-once semantics keyed on the IndexedDB flag stay.
- **Imported saves round-trip:** F-02/F-03 fixes must keep `importedSaves` merge behavior in `useFeed` intact (sync payload ∪ imported, pool wins).
- **Dequeue history writes are fire-and-forget:** D2's put-based writes must stay non-blocking on the interaction path.
- **`unsavedAtById` is load-bearing:** F-23 pruning must keep entries long enough for backfill (D5 caps must not starve F-01's ID source).
- **Legacy REC_STORE fallback (F-46):** confirm no production keys remain before retiring; otherwise parallelize reads instead.
- **Rate-limit changes (F-47):** any DO-based limiter must not add latency to the hot `/bundle` path.
- **MetaDO rework (D7):** existing WS clients reconnect on deploy; catchUp semantics must survive the session-state migration.
