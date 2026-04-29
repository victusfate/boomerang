# PRD — Shared Article Metadata

## Problem

Chrome AI tags articles locally on each device. Tags never leave the device
that generated them — a user on mobile sees no tags at all, and two devices
owned by the same person don't share each other's work. The network effect
of distributed AI tagging is entirely lost.

Additionally, there is no real-time signal between browser sessions; the
existing sync-worker uses 30s polling, which is noticeable when switching
between devices.

## Solution

A new `meta-worker` (Cloudflare Worker + Durable Object + KV) provides a
shared, public, real-time article metadata layer:

- Any client's Chrome AI automatically contributes tags to a global pool
  after local tagging completes.
- All clients receive those tags — on first load via the rss-worker bundle,
  and live via WebSocket while the browser is open.
- Users can also add manual tags inline on article cards.
- The DO hibernation API and layered rate limits keep costs near zero
  regardless of client count.

## User Stories

1. **As a mobile user (no Chrome AI)**, I see AI tags on articles that were
   tagged by any other user's browser, without doing anything.

2. **As a desktop user with Chrome AI**, my locally-generated tags are
   silently contributed to the network after tagging completes. I don't
   need to take any action.

3. **As any user**, when I open the app, article tags arrive with the article
   bundle — no extra wait, no extra request.

4. **As any user**, when another browser tags an article I'm currently viewing,
   the tag appears on my card within seconds — no refresh needed.

5. **As any user**, I can add or edit tags on any article card directly in the
   feed, without opening Settings.

6. **As the operator**, a misconfigured or malicious client cannot generate
   unbounded Cloudflare KV writes or DO CPU time.

## Implementation Decisions

### meta-worker (new)
- Cloudflare Worker + single global Durable Object + KV namespace `ARTICLE_META`
- DO uses hibernation API for zero-cost idle periods
- Routes:
  - `GET /health` — liveness check
  - `GET /ws` — WebSocket upgrade; DO manages connections
  - `POST /meta/tags` — HTTP fallback tag submission (non-WebSocket clients)
- DO message protocol: `subscribe`, `catchUp`, `submitTags` (client→DO);
  `tags`, `catchUp` (DO→client) — see design.md Q8
- Rate limits: N=3 contributors/article, 20 msg/min/connection, 50 articles/batch, 5s KV debounce

### rss-worker (modified)
- Add `ARTICLE_META` KV binding to `wrangler.jsonc`
- `GET /bundle` response gains `tags: { [articleId]: string[] }` field,
  populated from KV reads (one `getAll` per bundle, keyed by articleIds in response)
- KV miss = empty tags for that article; graceful, not an error

### news-feed client (modified)
- New `useMetaWorker` hook:
  - Opens WebSocket to meta-worker on mount
  - Sends `subscribe` with current articleIds
  - Handles `tags` and `catchUp` messages → updates `metaTagsMap` state
  - On Chrome AI tag completion → fires `submitTags` per article
  - Reconnect with catchUp on visibility change / disconnect
- `articleTagsMap` in `useFeed` merges local tags (Fireproof) + meta tags
  (metaTagsMap) — meta tags are read-only display layer
- Article card: inline tag editor (add/edit manual tags without opening Settings)
- `VITE_META_WORKER_URL` env var; default `https://boomerang-meta.boomerang.workers.dev`

### articleId (modified)
- `hashId` in `rss-worker/src/parseFeed.ts` upgraded from 32-bit polynomial
  to first 16 hex chars of SHA-256(url) via `crypto.subtle` ✓ (already done)

## Testing Strategy

- **meta-worker**: Vitest + `@cloudflare/vitest-pool-workers`
  - DO WebSocket lifecycle (connect, subscribe, submitTags, broadcast, catchUp)
  - Rate limit enforcement (N=3 cap, 20 msg/min)
  - KV write debounce
  - Hibernation round-trip
- **rss-worker**: extend existing smoke tests
  - `GET /bundle` response includes `tags` field
  - Missing KV entries produce empty tags (not errors)
- **news-feed**: node:test
  - `useMetaWorker` hook: subscribe, receive tags, submitTags trigger
  - `articleTagsMap` merge: local + meta, meta read-only

## Out of Scope

- Moderation or removal of bad tags (v2)
- Per-user tag attribution or voting on tags (v2)
- Non-tag metadata fields (summary, sentiment, etc.) — schema supports them
  but no AI pipeline writes them yet (v2)
- Sync-worker real-time upgrade (separate feature)
- Fixing `handleSyncMerge` no-op for saves/votes (separate P0 fix)
