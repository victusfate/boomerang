# Implementation plan — ai-topic-labels

Vertical slices — each cuts through data → logic → UI → tests end-to-end. Respects minimum-viable-diff: extends existing code rather than replacing it.

| Slice | Goal | Layers touched |
|-------|------|----------------|
| **1** | Data model + label CRUD | `types.ts`, `storage.ts`, `useFeed.ts`, unit tests |
| **2** | Topic bar soft takeover | `TopicFilter.tsx`, `App.tsx` (ActiveFilter), CSS, unit tests |
| **3** | Classification service | `services/labelClassifier.ts`, node test |
| **4** | Classification pass wired into feed load | `useFeed.ts`, `App.tsx` (idle scheduling), manual test |
| **5** | Label badge on article card | `ArticleCard.tsx`, CSS |
| **6** | Label suggestion service | `services/labelSuggester.ts`, Settings UI, unit test |
| **7** | Fireproof cloud sync + QR link flow | `useFeed.ts` (sync setup), Settings UI, `qrcode` package |

---

## Slice 1 — Data model + label CRUD

**What ships:** `UserLabel` type; `userLabels` field on `UserPrefs`; `ai-classifications` Fireproof document; add/rename/delete label helpers in `storage.ts`; `useFeed` exposes `userLabels`, `onAddLabel`, `onDeleteLabel`; loaded from Fireproof on mount.

**Files:**
- `news-feed/src/types.ts` — add `UserLabel`, `LabelHit`, `ClassificationsDoc`, `ActiveFilter`
- `news-feed/src/services/storage.ts` — `addUserLabel`, `deleteUserLabel`, `renameUserLabel`; `DEFAULT_PREFS` gets `userLabels: []`
- `news-feed/src/hooks/useFeed.ts` — load + persist `ai-classifications` doc; expose label handlers
- `news-feed/src/services/storage.node.test.ts` (new) — CRUD round-trip unit tests

**Acceptance:** `addUserLabel` / `deleteUserLabel` round-trip in tests; `userLabels` appears in returned hook state.

---

## Slice 2 — Topic bar soft takeover

**What ships:** `ActiveFilter` replaces `Topic | null` in `App.tsx`. `TopicFilter` accepts `userLabels` prop; renders label pills first, built-in topics in a collapsible overflow. Feed filtering routes on `kind`. No classifications yet — labels appear as pills but no articles are tagged.

**Files:**
- `news-feed/src/App.tsx` — `activeFilter: ActiveFilter` state; filter routing
- `news-feed/src/components/TopicFilter.tsx` — render user label pills; overflow `More` button for built-in topics
- `news-feed/src/App.css` — overflow panel styles
- `news-feed/src/components/TopicFilter.node.test.ts` (new) — label pills render before built-in topics; overflow hidden when no labels

**Acceptance:** With 0 user labels, bar looks identical to today. With 2 labels, they appear first; built-in topics hidden behind More button.

---

## Slice 3 — Classification service

**What ships:** `services/labelClassifier.ts` — `isPromptApiAvailable()`, `classifyArticle()`, `runClassificationPass()`. Tested with a mock `LanguageModel` session (node test, no real API needed).

**Files:**
- `news-feed/src/services/labelClassifier.ts` (new)
- `news-feed/src/services/labelClassifier.node.test.ts` (new)

**Test cases:**
- Session returns "YES" → `classifyArticle` returns `true`
- Session returns "NO" → returns `false`
- Article already in `existingHits` → skipped (no session call)
- `isPromptApiAvailable()` returns false when `LanguageModel` not in globalThis

**Acceptance:** All node tests pass; no real Prompt API required.

---

## Slice 4 — Classification pass wired into feed load

**What ships:** After `fetchAllSources` resolves in `useFeed`, if `isPromptApiAvailable()` and `userLabels.length > 0`, schedule `runClassificationPass` for each label via `requestIdleCallback`. New label hits merged into `ai-classifications` Fireproof doc. `labelHits` exposed from `useFeed`. Delta reclassification triggered when `onAddLabel` is called.

**Files:**
- `news-feed/src/hooks/useFeed.ts` — schedule classification after fetch; load `ai-classifications` on mount; merge hits; expose `labelHits`
- `news-feed/src/App.tsx` — pass `labelHits` to `TopicFilter` and `ArticleCard`

**Acceptance:** Manual — on Chrome 138+ desktop: add a label, wait for idle pass, verify hits written to Fireproof. No-op on unsupported browsers.

---

## Slice 5 — Label badge on article card

**What ships:** `ArticleCard` receives `articleLabelNames: string[]` prop (resolved from `labelHits` + `userLabels` in parent). Renders a small badge row below the source/time line when labels apply.

**Files:**
- `news-feed/src/components/ArticleCard.tsx` — `articleLabelNames` prop + badge render
- `news-feed/src/App.tsx` — resolve `articleLabelNames` from `labelHits` per card
- `news-feed/src/App.css` — `.label-badge` styles

**Acceptance:** Card with a matching label hit shows the badge; card without does not.

---

## Slice 6 — Label suggestion service

**What ships:** `services/labelSuggester.ts` — analyzes `prefs.topicWeights`, `prefs.keywordWeights`, and upvoted article titles; calls Prompt API to generate 3–5 label candidates. Settings panel shows "Suggested labels" chips (accept / dismiss). Accepted labels flow into `onAddLabel` → slice 4 delta pass.

**Files:**
- `news-feed/src/services/labelSuggester.ts` (new)
- `news-feed/src/components/Settings.tsx` — "AI Labels" section; suggestions UI; label list with delete
- `news-feed/src/services/labelSuggester.node.test.ts` (new) — mock session returns newline-separated labels; verify parsed correctly

**Acceptance:** Mock session → 3 parsed suggestions; UI shows accept/dismiss; accepted label appears in topic bar.

---

## Slice 7 — Fireproof cloud sync + QR link flow

**What ships:** `@fireproof/connect` (or current recommended connector) configured on DB init using stored `syncToken`. Token generated on first run, stored in `user-prefs`. Settings "Sync across devices" section renders a QR code (`qrcode` package) encoding `boomerang://sync?token=…`. Receiving device parses token from URL hash on load.

**Files:**
- `news-feed/src/hooks/useFeed.ts` — generate / load sync token; configure Fireproof connector
- `news-feed/src/components/Settings.tsx` — QR code display; "Scan on your phone" copy
- `news-feed/package.json` — add `qrcode` + `@fireproof/connect` (or equivalent)

**Acceptance:** Manual — classify on desktop, scan QR on mobile Chrome, reload mobile — label hits and user labels appear.

---

## tdd-log.md

Status lives in [tdd-log.md](./tdd-log.md).
