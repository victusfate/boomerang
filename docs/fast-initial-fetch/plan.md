# Implementation plan — fast-initial-fetch

Vertical slices: each extends the stack end-to-end (client fetch → rank → `useFeed` → tests) with minimum viable diffs. Order is suggested; adjust if a slice proves too big.

| Slice | Goal | Outcome |
|-------|------|--------|
| **1** | Partition + parallel fetch (no new merge semantics yet) | `newsService` runs fast (P1 built-in) and background (P2 + custom) in parallel; tag tier on articles or keep separate arrays until a single `onBatch` surface is defined. `useFeed` may still use one `applyRankedBatch` path temporarily — *accept* that first slice might still reorder; slice 2 fixes. |
| **2** | Tier penalty in `scoreArticle` / `rankFeed` | Background-tier articles (P2 + custom) get a defined penalty; unit tests for ordering vs fast-tier. |
| **3** | Anchor merge in `useFeed` | Replace/adjust `mergeFeedBackground` for background completion so the visible fast prefix is stable; integration-style tests for merge. |
| **4** | Cache + edge cases | Single `feed-cache` write when appropriate; no P1 enabled → background-only; verify YouTube split per tier. |
| **5** (optional) | Defer background start (Option C) | Only if product turns parallel start off — gate behind a constant or small helper. |

**Granularity check:** Slices 1–2 are separable; if slice 1 ships behind a feature flag, keep the flag in `useFeed` until slice 3 lands.

## `tdd-log.md`

Status table lives in [tdd-log.md](./tdd-log.md).
