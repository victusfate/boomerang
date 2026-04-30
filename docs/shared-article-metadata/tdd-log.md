# TDD Log — Shared Article Metadata

| Slice | Description | Status |
|-------|-------------|--------|
| S1 | meta-worker scaffold: wrangler.jsonc, KV binding, CORS, GET /health | done |
| S2 | DO WebSocket: connect, subscribe, ping/pong, graceful close + hibernation | done |
| S3 | submitTags (batch): DO accepts, normalises, rate-limits, writes KV | done |
| S4 | Tags broadcast: DO pushes `tags` messages to subscribed clients only | done |
| S5 | catchUp: client sends `since`, DO replies with delta from KV | done |
| S6 | rss-worker: ARTICLE_META KV binding + tags injected into GET /bundle | done |
| S7 | news-feed useMetaWorker hook: connect, subscribe, receive tags, catchUp | done |
| S8 | news-feed auto-submit: after Chrome AI batch, fire batched submitTags | done |
| S9 | news-feed articleTagsMap merge: local + meta tags unified in display | done |
| S10 | news-feed inline tag editor: add/edit tags on article cards in the feed | pending |

---

## S1 — meta-worker scaffold
- **Status**: done
- 3 tests pass: GET /health → 200, OPTIONS → 204, unknown → 404

## S3 — submitTags: normalise, rate-limit, write KV
- **Status**: done
- 7 tests pass: normalise, merge, KV write, union-merge, N=3 cap, batch-size cap, 20 msg/min rate-limit
- KV write debounce dropped (contributor cap already bounds writes to 3/article; simpler + testable)

## S2 — DO WebSocket connect + hibernation
- **Status**: done
- 4 tests pass: 101 upgrade + welcome, reconnect → welcome again, pong handling, 426 for non-WS
- `webSocketOpen` fires on hibernation wake; welcome sent eagerly from `fetch()` for first-connect compatibility in miniflare
