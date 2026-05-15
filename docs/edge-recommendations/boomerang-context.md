# Boomerang — Context for Edge Recommendations Repo

This doc captures the data structures, signals, and conventions the new
`rec-worker` repo needs to know about from `victusfate/boomerang`.

---

## Article identity

Article IDs are **16 hex chars** — the first 8 bytes of `SHA-256(articleUrl)`,
computed with `crypto.subtle` in the rss-worker at parse time:

```ts
const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
const id = Array.from(new Uint8Array(buf).slice(0, 8))
  .map(b => b.toString(16).padStart(2, '0')).join('');
// e.g. "a3f1c2d4b5e60718"
```

IDs are **URL-stable**: same article URL always produces the same ID across
devices and sessions. Custom (OPML) sources use the same scheme.

---

## Wire types

### `ArticleWire` — rss-worker output (`GET /bundle`)

```ts
interface ArticleWire {
  id:           string;        // 16 hex chars (SHA-256 of URL, first 8 bytes)
  title:        string;
  url:          string;
  description:  string;        // plain text, max 280 chars
  imageUrl?:    string;
  publishedAt:  string;        // ISO 8601
  source:       string;        // display name, e.g. "Ars Technica"
  sourceId:     string;        // stable slug, e.g. "ars-technica"
  topics:       Topic[];       // 1–3 items; "general" if nothing matched
  discussionUrl?: string;      // HN/Reddit comments URL when present in RSS
}
```

### `Article` — news-feed client type

Same fields as `ArticleWire` plus:
- `publishedAt: Date` (parsed from ISO string)
- `score?: number` (added by local ranking; not in wire format)
- `fetchTier?: 'fast' | 'background'` (P1 vs P2/custom sources)

---

## Topic taxonomy

Nine values — exactly this union:

```ts
type Topic =
  | 'technology' | 'science'   | 'world'         | 'business'
  | 'health'     | 'environment'| 'sports'        | 'entertainment'
  | 'general';
```

Topics are keyword-inferred at parse time in rss-worker; not ML-derived.
An article gets 1–3 topics; fallback is `['general']`.

---

## Built-in source catalogue

51 sources in `shared/rss-sources.json` — single source of truth for both
`rss-worker` and `news-feed`.

```ts
interface NewsSource {
  id:       string;      // e.g. "ars-technica", "bbc-world"
  name:     string;
  feedUrl:  string;
  category: Topic;
  enabled:  boolean;
  priority?: 1 | 2;     // 1 = fast tier; 2 = background (default)
}
```

Category breakdown: technology 18, science 13, world 8, environment 4,
entertainment 2, business 2, general 3, health 1, sports 1.

Custom (user-added) sources have IDs prefixed `custom-` and live only in
`UserPrefs.customSources` — they are never in `rss-sources.json`.

---

## User preference signals

All signals are persisted in **native IndexedDB** via a thin `kvStore.ts` wrapper
(DB name: `boomerang-kv`, object store: `kv`). Relevant document keys:

- `user-prefs` → `UserPrefs` document (weights, interaction history, toggles)
- `feed-cache` → last ranked article list + fetchedAt timestamp
- `rec:userId` → anonymous stable UUID used as the rec-worker userId

```ts
interface UserPrefs {
  // Explicit interactions
  upvotedIds:    string[];   // article IDs the user liked (toggled)
  downvotedIds:  string[];   // article IDs permanently hidden
  savedIds:      string[];   // bookmarked articles
  readIds:       string[];   // opened (max 1 000 most recent)
  seenIds:       string[];   // rendered in feed (max 2 000 most recent)

  // Learned weights — updated on every upvote/downvote, decayed weekly
  topicWeights:   Partial<Record<Topic, number>>;  // default 1.0, range 0.1–3.0
  sourceWeights:  Record<string, number>;           // keyed by sourceId
  keywordWeights: Record<string, number>;           // up to 500 words, range −5 to 5

  // Filters (user-configurable, not learned)
  disabledSourceIds: string[];   // blacklist — empty means all enabled
  enabledTopics:     Topic[];    // whitelist — empty means all enabled
  customSources:     CustomSource[];
}
```

### Weight update rules (current algorithm)

| Action | topicWeight delta | sourceWeight delta | keywordWeight delta |
|--------|------------------|--------------------|---------------------|
| upvote | +0.3, max 3.0 | +0.2, max 3.0 | +0.4 per word, max 5.0 |
| downvote | −0.2, min 0.1 | −0.15, min 0.1 | −0.3 per word, min −5.0 |

Weekly decay: topic weights drift 10% toward 1.0; keyword weights lose 15%
magnitude. No decay on source weights.

Keywords: lowercase words > 4 chars, stopwords removed, up to 12 extracted
per article, capped at 500 stored entries (evict lowest magnitude on overflow).

---

## userId for rec-worker

The news-feed generates a stable anonymous userId the first time the
`useRecWorker` hook initialises, stores it in IndexedDB under `rec:userId`,
and reuses it on subsequent visits. It is never linked to any PII.

```ts
// news-feed/src/services/recWorker.ts
export async function getOrCreateRecUserId(): Promise<string> {
  const existing = await kvGet<string>('rec:userId');
  if (existing) return existing;
  const id = crypto.randomUUID();
  await kvSet('rec:userId', id);
  return id;
}
```

---

## Current local scoring formula

For reference — the rec-worker should complement, not duplicate this:

```
score = recency(publishedAt)        // exp decay, half-life 12 h
      × sourceWeight[sourceId]
      × mean(topicWeight[topics])
      × diversityPenalty(sourceCount)  // 1 / (1 + log1p(n))
      + tanh(sum(keywordWeights)) × 0.5
```

Background-tier articles (P2 + custom) are multiplied by 0.2 post-score so
P1 sources naturally lead the feed.

---

## Client integration (`useRecWorker` hook)

`news-feed/src/hooks/useRecWorker.ts` — the hook that:
- Resolves/creates the anonymous userId on mount
- Buffers `RecInteractionInput` events (in-memory)
- Flushes every 30 s or when buffer hits 50 events via `POST /interactions`
- After each flush, fetches fresh recommendations via `GET /recommendations/:userId`
- Returns `sendInteraction`, `recArticleIds`, `recStatus`, `recEnvError`

`useFeed.ts` accepts `recInteract?: (input: RecInteractionInput) => void` via
`UseFeedOptions` and calls it inside all five interaction handlers (read, save,
upvote, downvote, seen).

Env: `VITE_PLATFORM_WORKER_URL` (or `VITE_REC_WORKER_URL`), local default `http://localhost:8787` (unified platform-worker).

---

## KV / Worker conventions (from meta-worker)

The existing `meta-worker` (boomerang-meta) is the closest structural
analogue. It uses:

- **KV namespace** binding name `ARTICLE_META` — per-article JSON blobs
- **Global Durable Object** `MetaDO` (class + binding name) — one instance
  (`name: 'global'`) handles all write coordination
- Cron trigger hourly for maintenance pruning

`wrangler.jsonc` baseline for rec-worker:

```jsonc
{
  "name": "ricochet-rec",
  "main": "src/index.ts",
  "compatibility_date": "2026-04-09",
  "kv_namespaces": [
    { "binding": "REC_STORE", "id": "<create with wrangler kv namespace create>" }
  ],
  "durable_objects": {
    "bindings": [{ "name": "REC_DO", "class_name": "RecDO" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["RecDO"] }]
}
```

---

## Interface boundary — what rec-worker exposes

```
POST /interactions          — ingest a batch of interaction events
GET  /recommendations/:userId  — return ranked article IDs
GET  /health                — { ok: true, service: 'ricochet-rec' }
```

### Interaction event shape

```ts
interface InteractionEvent {
  userId:    string;   // anonymous stable UUID from rec:userId in IndexedDB
  articleId: string;   // 16-hex article ID from boomerang
  sourceId:  string;
  topics:    Topic[];
  action:    'read' | 'upvote' | 'downvote' | 'save' | 'seen';
  ts:        number;   // epoch ms
}
```

### Recommendation response shape

```ts
interface RecResponse {
  articleIds: string[];   // ordered; client filters against its live pool
  generatedAt: number;
}
```

---

## What the rec-worker does NOT own

- Article fetching / RSS parsing — stays in `rss-worker`
- User prefs persistence — stays in IndexedDB (`news-feed`)
- Sync across devices — stays in `sync-worker`
- AI tags — stays in `meta-worker`
- Local re-ranking — stays in `news-feed/src/services/algorithm.ts`

The rec-worker owns only: **interaction ingestion** and **cross-user
collaborative signal** (BiasedMF online learning, global popularity ranking).
Per-user learned weights remain local in IndexedDB.
