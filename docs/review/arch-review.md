# Boomerang — Architecture & Product Review
_May 2026 · Claude Code_

## Overall Grades
| Dimension | Grade | Notes |
|---|---|---|
| Architecture | B+ | Clean monorepo; god-file in useFeed.ts is the main drag |
| Code quality | B | Clear intent throughout; magic numbers and scattered schemas |
| Product–goal alignment | B | Ranking is recency-heavy; custom feeds nearly invisible |
| Security | B− | Several high-priority issues patched; see security-findings.md |

---

## 1. Repository Structure — ✅ Solid

The three-package split (`news-feed/`, `platform-worker/`, `shared/`) is clean and sensible.  
The four platform-worker domains (RSS, Sync, Meta, Rec) are properly isolated at the routing level with no cross-domain imports detected.  
No circular dependencies.

---

## 2. Critical Issues

### 2a. `useFeed.ts` is a 1,100-line god file ⚠️ HIGH
`news-feed/src/hooks/useFeed.ts` mixes:
- Cache load / persistence (lines 410–575)
- Network refresh orchestration (lines 585–712)
- Progressive pagination (lines 729–735)
- All 13+ user interaction handlers
- AI tagging lifecycle (lines 289–414)
- Sync merge on startup (lines 476–575)
- Bookmark & OPML import/export (lines 860–976)
- Remote sync merging (lines 979–1021)

**Risk**: A single regression can break feed loading, ranking, AI tagging, sync, and bookmarks simultaneously.

**Recommended split:**
```
useFeedCache.ts        — kvGet/kvSet for prefs, articles, tags
useFeedNetwork.ts      — refresh(), fetchAllSources, onBatch
useFeedInteractions.ts — read, save, vote, seen (all handleX)
useFeedAiTags.ts       — Chrome AI lifecycle + scheduleTaggingPass
useFeedImportExport.ts — OPML, bookmark HTML, sync hash import
```

### 2b. Background-tier score penalty crushes custom feeds ⚠️ HIGH
`algorithm.ts:78`:
```typescript
if (inferFetchTier(article) === 'background') s *= BACKGROUND_TIER_SCORE_MULTIPLIER; // ×0.2
```
A priority-2 article with strong rec-boost (1.6×) still scores only `recency × diversity × 0.32` vs `recency × diversity × 1.0` for any priority-1 article. Custom OPML imports (always priority 2) are effectively invisible.

**Intent unclear**: Is this meant as a first-load cold-start penalty or permanent policy?

**Options:**
- Time-fade: `0.2 + 0.8 * min(1, ageHours / 4)` — penalty dissolves over first 4 hours
- Make it per-source-configurable via `rss-sources.json` `priority` field
- Move to fetch scheduling only (background tier = fetched later, no score penalty)

### 2c. Topic weights are stored but never used in ranking ⚠️ MEDIUM
`prefs.topicWeights` accumulates learned preferences via `boostTopic()` but `rankFeed()` never reads them. The only personalization path is through `recBoost` (ricochet BiasedMF).

When the rec cache is stale (first 5 min, or after a worker restart), all articles rank purely on recency + diversity. A user with strong tech preferences sees the same feed as a new user.

**Fix**: Blend topic weights into the local score as a light multiplier until rec warms up.

---

## 3. Personalization Pipeline

### What works
- End-to-end ricochet BiasedMF: interactions → `/interactions` → `RecDO` → `/recommendations` → `recRankMap` → `recBoost`
- Online learning: `save`(2.0), `upvote`(1.0), `read`(0.5), `seen`(0.1), `downvote`(−1.0)
- Fallback to pure recency + diversity when rec is unavailable

### Gaps
| Gap | Impact |
|---|---|
| `recBoost` range [1.0, 1.8] is conservative | At 3 days old, a top-ranked personalized article barely beats a fresh generic one |
| No "hide source" / "hide topic" model feature | Users can only downvote individual articles; the model can't learn "never show sports" |
| Cold start: new user has zero latent factors | First ~50 interactions produce near-random ranking |
| Background tier ×0.2 penalty pre-empts rec boost | Strong rec signals can't overcome the tier penalty |

---

## 4. Sync & State Management — ✅ Mostly Sound

- `mergePrefs()` uses timestamps for `savedAtById`/`unsavedAtById` — conflict-safe
- Label hits and article tags merge by timestamp — no data loss
- ETag-based conflict detection is correct; 412 on mismatch prevents silent overwrites

**Minor issue**: `applyRemoteSync()` uses optimistic updates — merged state goes to React state before `kvSet()` completes. One failed write leaves React state ahead of IndexedDB. This is standard practice but error handling could be tightened.

---

## 5. Code Quality — Key Items

| File | Lines | Status |
|---|---|---|
| `useFeed.ts` | 1,120 | Needs split (see 2a) |
| `algorithm.ts` | 122 | ✅ Clean — magic numbers need comments |
| `storage.ts` | 559 | ✅ Pure functions, well-organized |
| `newsService.ts` | 301 | Fair — chunking logic complex, untested |
| `types.ts` | ~200 | ✅ Good — canonical, well-named |

**Quick wins:**
- Add rationale comment to `FUZZY_DEDUPE_MAX = 350` and `0.65` similarity threshold (`algorithm.ts:53,35`)
- Add comment to `markedSeenRef` explaining session-only vs. `prefs.seenIds` persistent tracking
- Move `FeedCacheDoc`, `ImportedSavesDoc`, etc. out of `useFeed.ts` into `src/types/schemas.ts`

---

## 6. Product Goal Assessment
_"help people find and read great news they are interested in"_

| Aspect | Status |
|---|---|
| Recency | Strong — exponential decay, half-life ~8h |
| Diversity | Good — per-source interleaving bucket sort |
| Personalization | Weak at cold-start; improves to ~30% score contribution after interactions |
| Custom feeds | Broken — ×0.2 tier penalty makes them near-invisible |
| Topic filtering | Works — but topic *weights* don't boost rank |
| New-user experience | Falls back to pure recency; no popular-article cold-start |

**Highest-leverage product improvements (in order):**
1. Fix background-tier penalty (custom feeds visible)
2. Blend `topicWeights` into local score (personalization without waiting for rec warmup)
3. Add cold-start popular-item seeding to ricochet (see ricochet-update-plan.md)
4. Add "hide this source" / "hide this topic" controls

---

## 7. Preserved Strengths
- ✅ Progressive fetch with two-tier `onBatch` callbacks
- ✅ `feedShownRef` locking prevents background re-ranks (PR #49)
- ✅ Rec interaction model is well-designed (save/upvote/downvote/read/seen)
- ✅ Sync merge strategy with timestamps
- ✅ PWA caching via Workbox
- ✅ No circular dependencies
