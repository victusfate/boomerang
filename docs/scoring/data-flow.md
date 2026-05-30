# Boomerang Scoring — Data Flow Diagrams

## 1. Article Ingestion → Ranked Feed

Full pipeline from RSS sources through MF ranking to the rendered feed.

```mermaid
flowchart TD
    subgraph Ingest["RSS Ingestion — platform-worker"]
        SRC["RSS Sources\nshared/rss-sources.json"]
        PARSE["parseFeed()\npubDateStr → new Date(pubDateStr)\n→ .toISOString()"]
        BUNDLE["GET /bundle?include=id1,id2,…"]
        SRC --> BUNDLE --> PARSE
    end

    subgraph Client["Client — newsService.ts"]
        HYDRATE["parseArticles()\nnew Date(isoString) → Article.publishedAt: Date"]
        POOL["Article pool\n{ id, title, sourceId, publishedAt, fetchTier, topics }"]
        PARSE --> HYDRATE --> POOL
    end

    subgraph RecPipeline["Recommendation Pipeline — useRecWorker"]
        PRESORT["local pre-sort\nrankFeed(pool, prefs, [])"]
        CAP["cap to 400 candidate ids\nchunk into batches ≤ REC_MAX_CANDIDATES"]
        RECREQ["POST /recommendations/:userId\n{ candidateArticleIds, limit }"]
        RECDO["RecDO.scoreCandidates(userId, ids)\n→ ScoredArticle[]  sorted by ŷ DESC"]
        RANKMAP["recRankMap\nrank01 = position / max(n − 1, 1)\nrecBoost range [1.0, 1.8]"]
        POOL --> PRESORT --> CAP --> RECREQ --> RECDO --> RANKMAP
    end

    subgraph Ranking["Feed Ranking — algorithm.ts rankFeed()"]
        FILTER["filter:\n• seen / read ids\n• downvoted ids\n• disabled topics\n• ad filter\n• fuzzy dedup (title similarity > 0.65)"]
        SCORE["scoreArticle(article, sourceCounts, recRankMap)\nsee Diagram 3 for formula"]
        INTERLEAVE["sort by feedScore DESC\n→ bucket by sourceId\n→ round-robin interleave"]
        FEED["Ranked Article[]\n(progressive: 5 at a time via IntersectionObserver)"]
        POOL --> FILTER --> SCORE --> INTERLEAVE --> FEED
        RANKMAP --> SCORE
    end
```

---

## 2. MF Model — Online Training (learnOne)

How a single user interaction updates the global model state stored in the `REC_DO` Durable Object SQLite database.

```mermaid
flowchart TD
    subgraph ActionRatings["Action → Rating mapping (scoring.ts)"]
        R_SAVE["save     → r = 2.0"]
        R_UP["upvote   → r = 1.0"]
        R_READ["read     → r = 0.5"]
        R_SEEN["seen     → r = 0.1"]
        R_DOWN["downvote → r = −1.0"]
    end

    subgraph Dedup["Deduplication check"]
        DEDUP{"(userId, articleId, action)\nalready in interactions?"}
        SKIP["UPDATE ts only\n(no re-learning)"]
        INSERT["INSERT into interactions\n(userId, articleId, sourceId, action, topics, ts)"]
        DEDUP -->|yes| SKIP
        DEDUP -->|no| INSERT
    end

    subgraph LoadFactors["Load current factors from SQLite"]
        LOAD_GS["global_state: μ, n"]
        LOAD_U["user_factors WHERE user_id = ?\nbias bᵤ, latent vᵤ ∈ ℝ¹⁰\n(new user → normalSample(σ=0.1))"]
        LOAD_I["item_factors WHERE article_id = ?\nbias bᵢ, latent vᵢ ∈ ℝ¹⁰\n(new item → normalSample(σ=0.1))"]
    end

    subgraph SGD["Online SGD Step (mfLearnOne — scoring.ts)"]
        PREDICT["ŷ = μ + bᵤ + bᵢ + ⟨vᵤ, vᵢ⟩"]
        ERROR["e = clip(r − ŷ,  ±clipError=10)"]
        UPD_MEAN["μ' = μ + (r − μ) / (n + 1)"]
        UPD_BU["bᵤ' = bᵤ + η_bias · (e − λ_bias · bᵤ)\nη_bias = 0.05,  λ_bias = 0.0"]
        UPD_BI["bᵢ' = bᵢ + η_bias · (e − λ_bias · bᵢ)"]
        UPD_VU["vᵤ'[f] = vᵤ[f] + η_lat · (e · vᵢ[f] − λ_lat · vᵤ[f])\nη_lat = 0.05,  λ_lat = 0.05"]
        UPD_VI["vᵢ'[f] = vᵢ[f] + η_lat · (e · vᵤ[f]_old − λ_lat · vᵢ[f])\n(simultaneous update: uses vᵤ before update)"]
        PREDICT --> ERROR
        ERROR --> UPD_MEAN & UPD_BU & UPD_BI & UPD_VU & UPD_VI
    end

    subgraph Persist["Persist updated factors"]
        WRITE_GS["UPDATE global_state SET mean=μ', n=n+1"]
        WRITE_U["UPSERT user_factors\n(bias, v0…v9, updated_at)"]
        WRITE_I["UPSERT item_factors\n(bias, v0…v9, source_id, topic, updated_at)"]
    end

    ActionRatings --> Dedup
    INSERT --> LoadFactors
    LoadFactors --> SGD
    SGD --> Persist
```

---

## 3. MF Model — Inference (scoreCandidates)

How the trained model ranks candidate articles for a given user.

```mermaid
flowchart TD
    subgraph Inputs["Inputs"]
        CIDS["candidateArticleIds: string[]\n(from feed pool — up to REC_MAX_CANDIDATES)"]
        UID["userId"]
    end

    subgraph LoadUser["Load user state"]
        GET_GS["SELECT mean FROM global_state  → μ"]
        GET_U{"SELECT … FROM user_factors\nWHERE user_id = ?"}
        WARM_U["warm user\nbᵤ, vᵤ from DB"]
        COLD_U["cold-start user\nbᵤ = 0,  vᵤ = [0,…,0]\n(coldStart = true)"]
        GET_U -->|found| WARM_U
        GET_U -->|not found| COLD_U
    end

    subgraph LoadItems["Load item factors (batch)"]
        GET_I["SELECT … FROM item_factors\nWHERE article_id IN (…)"]
        DOWNVOTED["SELECT article_id FROM interactions\nWHERE user_id = ? AND action = 'downvote'"]
    end

    subgraph ScoreLoop["Score each candidate"]
        EXCL{"downvoted?"}
        SKIP2["exclude\nexcludedDownvotes++"]
        WARMITEM{"article_id in\nitem_factors?"}
        WARM_SCORE["warm item\nŷ = μ + bᵤ + bᵢ + ⟨vᵤ, vᵢ⟩\nwarmItemCount++"]
        COLD_SCORE["cold item\nbᵢ = 0,  vᵢ = [0,…,0]\nŷ = μ + bᵤ\n(all cold items score identically)\ncoldItemCount++"]
        EXCL -->|yes| SKIP2
        EXCL -->|no| WARMITEM
        WARMITEM -->|yes| WARM_SCORE
        WARMITEM -->|no| COLD_SCORE
    end

    subgraph Output["Output — RecCoreResponse"]
        SORT["sort by ŷ DESC,\nthen articleId ASC (tiebreak)"]
        RESP["{ articleIds, scoredArticleIds,\ngeneratedAt, diagnostics:\n  { coldStart, coldItemCount, warmItemCount,\n    candidateMode, candidateCount, rankedCount } }"]
        SORT --> RESP
    end

    Inputs --> LoadUser
    UID --> GET_U
    UID --> DOWNVOTED
    CIDS --> GET_I
    LoadUser & LoadItems --> ScoreLoop
    WARM_SCORE & COLD_SCORE --> SORT
```

---

## 4. Feed Score Decomposition

How the four multiplicative factors combine into a single `feedScore` per article, mirrored identically in `algorithm.ts` (`scoreArticle`) and `feedScoreBreakdown.ts` (`computeFeedScoreInsight`).

```mermaid
flowchart TD
    ART["Article\n{ publishedAt, sourceId, id, fetchTier }"]

    subgraph Recency["recencyScore(publishedAt)  — algorithm.ts"]
        AGE["ageHours = (Date.now() − publishedAt.getTime()) / 3 600 000"]
        EXP["raw = exp(−0.00320 × ageHours)\nk = ln(10)/720 ≈ 0.00320"]
        FLOOR["recency = max(raw, 0.1)\nfloor = 0.1 at 30 days"]
        RECEX["examples:\n  12 h → 0.962\n   1 d → 0.926\n   3 d → 0.797\n   1 w → 0.609\n   2 w → 0.371\n  30 d → 0.100  ← floor"]
        AGE --> EXP --> FLOOR -.-> RECEX
    end

    subgraph Diversity["diversityScore(sourceCounts, sourceId)  — algorithm.ts"]
        SCOUNT["sourceCounts[article.sourceId]\n(# of pool articles sharing this source)"]
        DIV["diversity = 1 / (1 + log₁₊(sourceCount))\nlog₁₊(x) = ln(1 + x)"]
        DIVEX["examples:\n  1 article  → 1.000\n  2 articles → 0.631\n  5 articles → 0.441\n 10 articles → 0.346"]
        SCOUNT --> DIV -.-> DIVEX
    end

    subgraph RecBoost["recBoostScore(recRank01)  — algorithm.ts"]
        LOOKUP["recRankMap.get(article.id)\nrank01 = position / max(n − 1, 1)"]
        IN_LIST{"in rec list?"}
        BOOST["recBoost = 1.0 + (1.0 − rank01) × 0.8\nrank01=0 (top)  → 1.80\nrank01=0.5      → 1.40\nrank01=1 (last) → 1.00"]
        DEFAULT["recBoost = 1.0\n(not ranked by MF model)"]
        LOOKUP --> IN_LIST
        IN_LIST -->|yes| BOOST
        IN_LIST -->|no| DEFAULT
    end

    subgraph Tier["Tier multiplier  — algorithm.ts"]
        FETCHTR["article.fetchTier"]
        FAST["fast  → tierMultiplier = 1.0\n(primary RSS sources)"]
        BG["background → tierMultiplier = 0.2\n(secondary / slow sources)"]
        FETCHTR --> FAST & BG
    end

    subgraph Composite["Final score"]
        FORMULA["feedScore = recency × diversity × recBoost × tierMultiplier\n\ntheoretical max (fast, sole source, top rec, fresh):\n  0.962 × 1.000 × 1.80 × 1.0  ≈  1.73\n\nold article floor (fast, 30 d+, mid-pack):\n  0.100 × diversity × 1.0  × 1.0"]
    end

    ART --> Recency & Diversity & RecBoost & Tier
    FLOOR & DIV & BOOST & DEFAULT & FAST & BG --> FORMULA
```

---

## 5. Client-Side Rec Flush / Refresh Cycle

Timing diagram showing the interaction between the flush timer, pool ranking trigger, and the 5-minute periodic refresh.

```mermaid
sequenceDiagram
    participant U as User
    participant FH as useFeed (hook)
    participant RW as useRecWorker (hook)
    participant W as platform-worker

    U->>FH: reads / saves / votes article
    FH->>RW: sendInteraction(input)
    Note over RW: buffer push<br/>recordInteraction() → Fireproof local stats

    loop every 30 s (FLUSH_INTERVAL_MS)
        RW->>W: POST /interactions { events }
        W-->>RW: { ok: true, queued: N }
        Note over W: RecDO.learnOne() per event<br/>SGD updates μ, bᵤ, bᵢ, vᵤ, vᵢ
    end

    FH->>FH: feed pool snapshot stable<br/>(cache load or fetch complete)
    FH->>RW: onArticlePoolIds(ids[])

    Note over RW: debounce 1 500 ms<br/>pool key changed?

    RW->>W: POST /recommendations/:userId<br/>{ candidateArticleIds, limit }
    Note over W: RecDO.scoreCandidates()<br/>check ranking_cache (SQLite)<br/>hit → return cached payload<br/>miss → score + cache (TTL: pool=5 min)
    W-->>RW: RecResponse { articleIds, scoredArticleIds,<br/>diagnostics { coldStart, coldItemCount … } }
    RW->>FH: recArticleIds, recScoreById → rankFeed() re-sort

    loop every 5 min (RECS_FETCH_INTERVAL_MS)
        RW->>W: POST /recommendations/:userId (same pool)
        W-->>RW: refreshed rankings
        RW->>FH: re-sort if feed-pool mode
    end
```

---

## 6. Ricochet — Model Hyperparameters

Default values from `DEFAULT_MF_PARAMS` in `@victusfate/ricochet` `src/scoring.ts`.

| Parameter | Default | Notes |
|-----------|---------|-------|
| `nFactors` | 10 | Latent vector dimensionality `k` |
| `lrBias` | 0.05 | Learning rate for `bᵤ` and `bᵢ` |
| `lrLatent` | 0.05 | Learning rate for `vᵤ` and `vᵢ` |
| `l2Bias` | 0.0 | L2 regularisation on bias terms (off) |
| `l2Latent` | 0.05 | L2 regularisation on latent vectors |
| `clipError` | 10.0 | Error clipped to `[−10, +10]` before SGD |
| `sigmaInit` | 0.1 | Std dev for Box-Muller normal init of latent vectors |

Candidate pool sizes (boomerang-specific, in `recPoolMerge.ts`):

| Constant | Value | Meaning |
|----------|-------|---------|
| `REC_MAX_CANDIDATES` | 100 | Max ids per single POST /recommendations batch |
| `REC_POOL_CANDIDATE_CAP` | 400 | Max pool ids sent total (client truncates before chunking) |

Cache TTLs (exported from `@victusfate/ricochet` public lib API since v1.3.1; used in boomerang's `RecDO.ts` SQLite cache):

| Constant | Value | Scope |
|----------|-------|-------|
| `REC_FEED_POOL_CACHE_TTL_MS` | 5 min | Feed-pool mode (pool changes per refresh) |
| `REC_GLOBAL_CACHE_TTL_MS` | 1 hour | Global candidate mode (stable discovery results) |

---

## 7. Ricochet — Cache Architecture (Boomerang Override)

The standalone ricochet worker uses **KV** (`REC_STORE`) for caching recommendation snapshots.
Boomerang's `platform-worker` overrides this with **SQLite inside the Durable Object** (`ranking_cache` table in `RecDO.ts`) to avoid KV quota consumption.

```
ricochet standalone:
  RecDO → scores → Worker → KV.put(cacheKey, payload, { expirationTtl })
                    ↑
                 KV.get(cacheKey) on hit

boomerang platform-worker (override):
  RecDO._handleRecs():
    1. SQLite: SELECT payload FROM ranking_cache WHERE cache_key = ? AND expires_at > now
       → cache hit: return payload directly (no KV)
    2. Cache miss: super.fetch() → base RecDO scores candidates
    3. SQLite: INSERT OR REPLACE INTO ranking_cache (cache_key, payload, expires_at)
       → TTL: REC_FEED_POOL_CACHE_TTL_MS or REC_GLOBAL_CACHE_TTL_MS
```

Cache key format (boomerang `RecDO.ts`):

| Mode | Key |
|------|-----|
| Global (no candidates) | `recs:{userId}:global:{limit}` |
| Feed-pool | `recs:{userId}:pool:{sha256(sorted ids)[:24hex]}:{limit}` |

Cron (`/prune` POST, hourly): deletes expired `ranking_cache` rows + prunes interactions older than 30 days + removes `item_factors` for articles with no remaining interactions.

---

## 8. Ricochet — Offline Evaluation (MovieLens 100K)

Source: ricochet README. 100K ratings, 943 users, 1 682 items, 80/20 train/test split.

| Predictor | RMSE | MAE |
|-----------|------|-----|
| Global mean | 1.122 | 0.941 |
| Item mean | 1.017 | 0.811 |
| **BiasedMF** (`DEFAULT_MF_PARAMS`) | **0.930** | **0.733** |

Run locally: `cd platform-worker/node_modules/@victusfate/ricochet && make eval`
