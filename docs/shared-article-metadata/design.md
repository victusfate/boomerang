# Design — Shared Article Metadata

## Q&A Summary

**Q1: Who can write to the shared metadata store?**
Any boomerang-news client, anonymously. No auth required. The source is
Chrome AI (deterministic for the same article text), so tag quality is
consistent regardless of which user generates them. Rate-limited by
articleId to prevent spam.

**Q2: What does shared article metadata include?**
An extensible per-article metadata object — tags now, additional AI-derived
fields (summary, sentiment, key people, reading level, etc.) added later
without schema migration. Shape is open; new fields slot in alongside tags.

**Q3: Durable Object topology?**
One global metadata DO. All clients connect via a single WebSocket endpoint,
send a subscription list of articleIds they have loaded, and receive only
updates for those articles. One connection per browser tab, no per-article
connections. Subscription list refreshed as the user loads more articles.

**Q4: How do clients receive the initial tag state?**
Both inline and live:
- Cold start: tags for the current article batch arrive embedded in the
  `GET /bundle` response from the rss-worker (reads from shared KV).
  Zero extra round trips.
- While open: DO WebSocket pushes tag deltas as any client submits new tags.

**Q5: Offline / reconnect strategy?**
Client stores `lastTagsAt` (epoch ms, UTC). On reconnect or tab-visible,
sends `{ type: "catchUp", since: lastTagsAt }`. DO replies with all updates
since that timestamp. If `lastTagsAt` is absent or >24h stale, next bundle
fetch delivers full tags inline. No message queue needed.

**Q6: New worker or extend existing?**
New dedicated worker: `meta-worker`. Sync-worker is private/per-user/token-
auth. Meta-worker is public/global/open-read. Mixing them creates auth
confusion and couples unrelated lifecycles.

**Q7: KV storage schema?**
```
Key:   meta:{articleId}
Value: {
  "articleId": "a3f8c2...",    // 16-hex SHA-256 prefix of article URL
  "tags": ["ai", "climate"],
  "updatedAt": 1234567890123,  // UTC epoch ms
  "contributors": 2
}
```
One KV entry per article, updated in place (union merge). KV namespace
declared in both `meta-worker/wrangler.jsonc` and `rss-worker/wrangler.jsonc`
as the same binding — no cross-worker HTTP calls.

**Q8: WebSocket message protocol?**

Client → DO:
```jsonc
{ "type": "subscribe",  "articleIds": ["a3f8...", "b2c1..."] }   // on connect
{ "type": "catchUp",    "since": 1234567890123 }                 // on reconnect
{ "type": "submitTags", "articles": [                            // batch, max 50
    { "articleId": "a3f8...", "tags": ["ai", "climate"] },
    { "articleId": "b2c1...", "tags": ["tech"] }
  ]
}
```

DO → Client:
```jsonc
{ "type": "tags",    "articleId": "a3f8...", "tags": ["ai","climate"], "updatedAt": 1234567890123 }
{ "type": "catchUp", "updates": [{ "articleId": "...", "tags": [...], "updatedAt": ... }] }
```

All JSON. DO only pushes to clients subscribed to a given articleId.

**Q9: Contributor / write rate limit per article?**
N=3 contributors max per article. Once 3 distinct clients have submitted
tags for an article, the DO rejects further `submitTags` for that article
silently. Tags from all contributors are union-merged into one set.

**Q10: Tag normalization?**
Lowercase + trim + deduplicate, applied by the DO before storage.
`" AI Safety "` and `"ai safety"` both become `"ai safety"`.

**Q11: Client-side integration with existing tag system?**
Meta-worker tags merge into `articleTagsMap` as a read-only layer, unioning
with locally-generated tags for display. Never written to Fireproof.
User's own tags (in Fireproof via sync-worker) remain the source of truth
for personal label filters. Two sources, one merged view, no conflicts.

**Q12: When does a client submit tags to the meta-worker?**
Automatically, **while** Chrome AI is actively processing articles. Tags are
flushed using a count-or-timer strategy: whichever fires first —
50 articles accumulated OR 20 seconds elapsed. The flush timer is active only
during an in-progress tagging pass; it stops when the pass ends (or the tab
closes mid-pass). Any remaining buffered articles are flushed immediately when
the pass completes.

- Fast hardware (desktop, ~4 articles/sec): 50 articles fills in ~12.5s →
  mostly count-triggered; at most 3 flushes/min.
- Slow hardware (laptop, ~0.5 articles/sec): ~10 articles per 20s window →
  timer-triggered; well under the 20 msg/min limit.
- Tab closed mid-pass: at most 20s of tagged articles are lost — not queued or
  retried; no user action required.

**Q13: DO hibernation?**
Uses the Cloudflare DO hibernation API. DO suspends when the last WebSocket
closes, wakes in ~5ms on new connection. KV holds all durable metadata
independently — zero data-loss risk during hibernation. Recommended
Cloudflare pattern for WebSocket DOs.

**Q14: Rate limits for cost protection?**
Three layers:
1. Per-article contributor cap: N=3 (hard ceiling on KV writes per article, ever)
2. Per-connection message rate: max 20 messages/minute; DO closes connection if exceeded
3. Per-message batch cap: max 50 articles per `submitTags` message
4. KV write debounce: 5s debounce per articleId; rapid same-article submissions
   collapse into one KV write

At 4 articles/sec Chrome AI throughput: 50-article count limit fires in ~12.5s,
producing at most 3 flushes/min — well within the 20 msg/min limit. On slow
hardware the 20s timer governs, capping at 3 msg/min regardless.

A noisy client cannot generate unbounded KV writes. An article that has
reached N=3 contributors generates zero additional writes regardless of
traffic.

---

## Canonical Vocabulary

| Term | Definition |
|---|---|
| **meta-worker** | New Cloudflare Worker: global/public article metadata via DO + KV |
| **sync-worker** | Existing Cloudflare Worker: private per-user cross-device sync via R2 |
| **article metadata** | Extensible per-article object: tags + future AI-derived fields |
| **tags** | Lowercase string array on an article, contributed by any user's browser AI |
| **contributor** | A client session that submitted at least one `submitTags` for an article |
| **articleId** | First 16 hex chars of SHA-256(articleUrl); deterministic, collision-safe |
| **KV** | Cloudflare KV namespace shared between meta-worker and rss-worker; durable tag store |
| **metadata DO** | Single global Durable Object; WebSocket hub + KV write coordinator |
| **subscription** | Set of articleIds a connected client wants live updates for |
| **catchUp** | Reconnect protocol: client sends `lastTagsAt`, DO replies with delta since then |
| **bundle** | `GET /bundle` response from rss-worker; includes inline tags from KV |
| **manual tags** | User-entered tags on an article card; editable inline in the feed UI |
| **meta tags** | Tags received from meta-worker; read-only display layer in articleTagsMap |
| **private sync** | sync-worker domain: prefs, saves, votes, bookmarks, per-user AI tags |
| **public metadata** | meta-worker domain: AI-discovered facts about articles, shared across all users |

---

## Edge-Case Scenarios

1. **Two browsers tag the same article simultaneously** — both submit to DO;
   DO processes serially (single-threaded), union-merges tags, increments
   contributors. Second submission may push contributors to 3 and close writes.

2. **Article URL changes (redirect/canonical)** — articleId is hashed from the
   URL the rss-worker parsed, which may differ from the final URL. Tags are
   stored under the parsed URL's hash. Canonical URL normalization in parseFeed
   reduces but doesn't eliminate this. Acceptable for v1.

3. **User has no Chrome AI** — they receive meta tags from the bundle and live
   WebSocket pushes but never submit. Full read-only participant.

4. **DO hibernates while a client is mid-session** — Cloudflare hibernation API
   preserves WebSocket connections; client does not notice. DO rehydrates state
   from DO storage on first message after wake.

5. **KV eventual consistency** — rss-worker may read slightly stale tags (KV
   global consistency ~60s). Acceptable: tags are additive/display-only, not
   transactional.

6. **rss-worker KV read fails** — bundle response omits `tags` field; client
   renders articles without tags. WebSocket connection to meta-worker provides
   tags shortly after. Graceful degradation.

7. **Contributor count reaches 3, new unique tags emerge later** — those tags
   are lost. Accepted tradeoff: N=3 is a cost/quality balance, not a guarantee
   of completeness.
