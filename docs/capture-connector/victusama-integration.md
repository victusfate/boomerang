# Reading the boomerang saved list from victusama

How victusama (or any backend agent) pulls the articles you capture with the
boomerang bookmarklet, so it can tag them and ingest them. Read-only: capture
*writes* happen via the bookmarklet; victusama only reads.

## The endpoint

```
GET {WORKER_URL}/sync/{ROOM_ID}/meta
```

- **`WORKER_URL`** — `https://api.boomerang-news.com` once the worker custom
  domain is deployed. Until then, the `*.workers.dev` URL works the same.
- **`ROOM_ID`** — your 64-hex sync room id. Find it in the boomerang app under
  **Settings → Sync across devices**. This is the sync room the bookmarklet
  attaches captures to.

No `Authorization` header. The endpoint is unauthenticated by design — **the
`ROOM_ID` is the secret.** Anyone holding it can read the whole saved list.

### Auth & CORS notes

- CORS does not apply: it only restricts browser JS by origin. A server-side
  agent (a Worker, a Node/TS script, an HTTP client) makes a direct request and
  ignores CORS entirely.
- There is a per-room rate limit. Poll on demand or every few minutes — don't
  hammer it.
- The response carries an `ETag`. Send `If-None-Match: <etag>` to get `304 Not
  Modified` when nothing changed — cheap polling.

## Response shape

`200` with JSON. The blob is the app's full sync state; the parts that matter
for captures:

```jsonc
{
  "v": 1,
  "savedArticles": [
    {
      "id": "Zk2…",                       // unique capture id
      "title": "Article title",
      "url": "https://example.com/article",
      "description": "your selected text, if any",  // the bookmarklet "note"
      "publishedAt": "2026-06-23T19:30:00.000Z",     // capture timestamp (ISO)
      "source": "Capture",                // bookmarklet captures are tagged this
      "sourceId": "capture",
      "topics": ["general"]
    }
    // …newest first
  ],
  "prefs": {
    "savedIds": ["Zk2…", "…"],            // newest first
    "savedAtById": { "Zk2…": 1782… }       // id → epoch ms
  }
}
```

- `savedArticles` holds everything saved in the room (in-app saves too). Filter
  to `source === "Capture"` if you only want bookmarklet captures.
- A `404` means the room has no saved data yet (nothing captured).

## Incremental pulls

Use `prefs.savedAtById` (epoch ms) to fetch only what's new since the last run:
keep a `lastSeenMs` watermark, then keep captures whose `savedAtById[id] >
lastSeenMs`. Combine with `If-None-Match` to skip the body entirely when nothing
changed.

## Reference implementation (TS / fetch)

```ts
const WORKER_URL = "https://api.boomerang-news.com";
const ROOM_ID = process.env.BOOMERANG_ROOM_ID!; // store as a secret, never commit

interface SavedArticle {
  id: string; title: string; url: string; description: string;
  publishedAt: string; source: string; sourceId: string; topics: string[];
}

export async function fetchCaptures(sinceMs = 0): Promise<SavedArticle[]> {
  const res = await fetch(`${WORKER_URL}/sync/${ROOM_ID}/meta`);
  if (res.status === 404) return [];          // nothing saved yet
  if (!res.ok) throw new Error(`saved-list read failed: ${res.status}`);

  const blob = await res.json() as {
    savedArticles?: SavedArticle[];
    prefs?: { savedAtById?: Record<string, number> };
  };
  const savedAt = blob.prefs?.savedAtById ?? {};
  return (blob.savedArticles ?? [])
    .filter(a => a.source === "Capture")
    .filter(a => (savedAt[a.id] ?? 0) > sinceMs);
}
```

Then tag / ingest each returned article however victusama handles its reading
queue, and advance `sinceMs` to the max `savedAtById` you processed.

## Storing the ROOM_ID on victusama's side

Treat it like a credential. Put it in victusama's gitignored config (e.g. an
env var `BOOMERANG_ROOM_ID` or a `connections.md` entry that isn't committed),
not in source. Rotating it means creating a new sync room in the app and
re-pointing the bookmarklet — so keep it private.
