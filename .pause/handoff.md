# Pause handoff

**When:** 2026-06-18  
**Branch:** `claude/custom-news-feed-app-NcrzS` (news-feed workspace)

---

## Goal

Bring all `news-feed/src/` audit scores to 9+ across all four rubric dimensions (Quality, Readability, Encapsulation, Clarity).

---

## Active artifacts

| Path | Status |
|------|--------|
| `news-feed/src/` | Audit complete; all mechanical + structural fixes applied and pushed |
| `news-feed/package.json` | Upgraded to ricochet v2.0.0 |
| `platform-worker/package.json` | Pinned to ricochet v1.10.0 (v2.0.0 `./worker` entry broken) |

---

## Done this session

- **Ricochet upgrade**: news-feed → v2.0.0 (client entry OK), platform-worker → v1.10.0 (worker entry broken in v2.0.0 due to missing `files` entries)
- **`labelClassifier.ts`**: Fixed Node ESM import extension (`.ts`) — restored all 99 tests
- **Audit pass** on `news-feed/src/`: all 65+ files scored, 16 below 9 in at least one dimension
- **Refactor commit** (`d57a926`): 13 files fixed across all audit findings:
  - `useSyncWorker`: hoisted types, added `COOLDOWN_TICK_MS`
  - `useArticlePool`: replaced useEffect ref-sync with direct body assignments; renamed `apply→applyBatchToState`
  - `App.tsx`: `SKELETON_CARD_COUNT`, `syncBusy`, `ogSentinelIndex`, inlined `formatLastRefresh`
  - `useFeed`: removed dead reference equality check
  - `useAiTagging`: type annotation cleanup, documented empty-dep effect
  - `useRecHistoryReplay`: hoisted types, extracted named `runReplay` async fn
  - `algorithm`: `FUZZY_DEDUPE_MAX` comment, extracted `interleaveBuckets`
  - `syncShare`: guarded console.info behind `isSyncDebugEnabled()`
  - `debugSync`: optional-chained `import.meta.env?.` for Node compatibility
  - `storage`: `VoteWeightUpdate` type alias, shared `hashUrl` helper
  - `RecDiagnostics`: moved constant, renamed `previewIds→topRatedIds`
  - `SourcesSection`: moved constant, extracted `makeImportHandler`
  - `newsService`: removed dead `partitionSourcesForSplitFetch` re-export

---

## Next steps

1. **Re-run audit** to verify all scores are now 9+:
   ```
   /audit news-feed/src/
   ```
2. **If residual issues remain**, focus on the largest structural extractions not yet done:
   - `useFeed.ts`: extract `handleStartupLoad` from the 130-line `Promise.all` callback (line 186)
   - `useAiTagging.ts`: the 115-line `scheduleTaggingPass` useCallback still has a large nested IIFE body
   - `App.tsx`: destructuring walls (`useMetaWorker` 8 names, `useRecWorker` 14 names, `useFeed` 34 names)
3. **Platform worker**: Once ricochet v2.0.0 fixes its `files` field, upgrade platform-worker too

---

## Open questions

- Does ricochet v2.0.0 have a patch yet for the `./worker` entry broken `files` field?
- Is the `useFeed.ts` `handleStartupLoad` extraction worth the diff size (~40 lines moved)?

---

## How to resume

From any device: `/resume` reads this file and continues.  
On this machine: `claude -c` reopens the full conversation history (richer than handoff).
