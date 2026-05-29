# Ricochet Update Plan
_May 2026 · Boomerang integration review_

This document describes the gaps found in Boomerang's recommendation pipeline and the corresponding changes needed in `@victusfate/ricochet`.

---

## Context: How Boomerang Uses Ricochet

```
user interaction (read / save / upvote / downvote / seen)
  → POST /interactions  (platform-worker RecDO)
  → ricochet BiasedMF online update

every 5 min + on article pool change:
  candidate IDs (up to 400) → POST /recommendations/:userId
  → ricochet scores candidates → ranked ID list
  → recRankMap built in client
  → recBoost = 1.0 + (1.0 - recRank01) * 0.8   (range: 1.0 – 1.8×)
  → final score = recency × diversity × recBoost
```

---

## Gap 1 — Cold-Start: New Users See Random Ranking (Priority: HIGH)

### Problem
A brand-new user has zero latent factors. `RecDO.scoreCandidates()` returns near-random scores until ~50 interactions. During this window Boomerang falls back to pure `recency × diversity`, which is reasonable but misses the chance to surface genuinely popular articles.

### What Ricochet Needs
**Item popularity bias seeding**: When a new user's latent factors are zero/uninitialized, the scoring function should blend in a pre-computed global item-popularity signal so that widely-read articles rank above obscure ones.

Proposed API change (or configuration):
```typescript
// ricochet config
{
  coldStartBlend: 0.6,  // weight of popularity bias before Σ interactions > threshold
  coldStartThreshold: 30,  // interactions needed to fully trust latent factors
}
```

The popularity signal can be derived from aggregate interaction counts already stored in `REC_DO` — no new data collection needed.

---

## Gap 2 — Topic/Source Preferences Not Exposed to the Model (Priority: HIGH)

### Problem
Boomerang stores learned topic weights in `prefs.topicWeights` (e.g., `{ technology: 1.4, sports: 0.6 }`) and source weights in `prefs.sourceWeights`. These are updated from `upvote` / `boostTopic` calls but are **never sent to ricochet**. The BiasedMF model learns from individual article interactions but cannot generalize "this user dislikes sports" without seeing many sports downvotes.

### What Ricochet Needs
**User bias injection endpoint**: Accept topic/source preference vectors alongside interactions, or as a separate `PATCH /users/:userId/preferences` call.

```typescript
// New or extended interaction payload
interface RecInteractionInput {
  articleId: string;
  sourceId:  string;
  topics:    Topic[];
  action:    RecAction;
  ts:        number;
  // NEW: pass current preference context with every interaction
  topicWeights?:  Record<string, number>;
  sourceWeights?: Record<string, number>;
}
```

The model can use these as user-feature side information in a factorization machine or as a bias override on the final score.

**Minimum viable version**: Add `topicBias` to the `scoreCandidates` call so Boomerang can apply a pre-scoring multiplier before ranking, letting local topic weights amplify the MF output without changing the model internals.

---

## Gap 3 — Tier Penalty Fights Personalization (Priority: MEDIUM)

### Problem
Boomerang applies a ×0.2 score multiplier to all background-tier (priority-2) articles. This means a custom-feed article with `recBoost = 1.8` scores only `0.36`, lower than any fresh priority-1 article at `1.0`. Ricochet's recommendations for custom sources are effectively nullified.

### What Ricochet Needs (or Boomerang adjustment)
This is primarily a Boomerang-side fix (remove or time-fade the tier penalty, see arch-review.md §2b), but ricochet could help by:

**Returning confidence scores alongside ranks**: If ricochet returns a confidence value `[0, 1]` per candidate, Boomerang can use it to override the tier penalty for high-confidence recommendations:
```
finalScore = recency × diversity × recBoost × max(tierPenalty, confidence)
```

---

## Gap 4 — Source/Topic "Never Show" Signal (Priority: MEDIUM)

### Problem
Users can downvote individual articles but cannot express "never show me sports" at the model level. Topic-disable toggles in prefs filter articles out entirely but don't feed back into the model.

### What Ricochet Needs
**Negative item-class signal**: Accept a `dislikedTopics: Topic[]` or `dislikedSources: string[]` field in the user interaction or preference update. The model should apply a persistent negative bias to items in those classes regardless of individual article features.

This could be as simple as a stored negative weight in `REC_STORE` that scales the MF output for matching item tags.

---

## Gap 5 — Recommendation Window Too Long (Priority: LOW)

### Problem
Recommendations are cached for 5 minutes (`RECS_FETCH_INTERVAL_MS`). If the user reads 10 articles in 3 minutes, the next fetch still uses stale rankings that don't reflect those interactions.

### What Ricochet Needs
**ETag / version token on recommendations**: Return a monotonic version or content hash with `/recommendations`. Boomerang can then send `If-None-Match` and short-circuit the poll early without fetching a full ranked list.

Alternatively, ricochet could push an invalidation event (WebSocket or Server-Sent Event) when a user's model has been updated enough to warrant a re-rank.

---

## Implementation Priority

| Gap | Ricochet Change | Boomerang Change | Priority |
|---|---|---|---|
| Cold-start popularity blend | ✅ Required | None | HIGH |
| Topic/source preference injection | ✅ Required (new endpoint or payload field) | Send `topicWeights` with interactions | HIGH |
| Tier penalty + confidence score | Optional (return confidence) | Fix tier penalty locally | MEDIUM |
| "Never show" source/topic | ✅ Required (new preference field) | UI toggle → new API call | MEDIUM |
| Recommendation ETag | ✅ Required | Use `If-None-Match` in poll | LOW |

---

## Suggested Versioning

These changes are breaking for the interaction payload (Gap 2) and additive for everything else. Recommend:

- **Ricochet v1.1**: Cold-start popularity blend + recommendation ETag (non-breaking)
- **Ricochet v1.2**: Topic/source preference injection (additive payload field, backward-compatible if optional)
- **Ricochet v1.3**: "Never show" negative class signal (new endpoint)

Boomerang's `platform-worker` pins `@victusfate/ricochet` — bump the version in `platform-worker/package.json` and re-deploy after each ricochet release.
