# Boomerang News

Algorithmic RSS news feed — React PWA backed by several Cloudflare Workers.

Live at [boomerang-news.com](https://boomerang-news.com)

## Architecture

The frontend (`news-feed/`) is a React + Vite PWA that stores all user state
locally in **native IndexedDB** (via a thin `kvStore.ts` wrapper). Four workers
handle the server-side concerns:

| Package | Role |
|---------|------|
| **`rss-worker/`** | Aggregates built-in and custom RSS feeds → **`GET /bundle`** (staggered fetches, full HTML5 entity decoding). Serves **`GET /og-image`** for lazy card thumbnails. Reads the shared KV namespace to inline AI tags from `meta-worker`. |
| **`meta-worker/`** | Per-article shared metadata (AI-derived tags). **`GET /meta?ids=…`** for bulk reads; **`POST /meta/tags`** for batched writes. One global Durable Object (`MetaDO`) coordinates writes; KV namespace shared with `rss-worker`. |
| **`sync-worker/`** | Cross-device sync of prefs, bookmarks, and labels over R2. **`POST /sync/room`** creates a room; **`GET/PUT /sync/{roomId}/meta`** and **`GET/PUT /sync/{roomId}/blocks/{cid}`** transfer data. Share links carry `roomId:token:workerUrl` in the URL fragment — the raw token never travels in query strings. |
| **[ricochet](https://github.com/victusfate/ricochet) (external)** | Edge collaborative filtering. **`POST /interactions`** ingests anonymous events; **`GET /recommendations/:userId`** returns ranked article IDs via a global BiasedMF Durable Object (SQLite). Lives in its own repo, port `8790` locally. |

`VITE_RSS_WORKER_URL`, `VITE_SYNC_WORKER_URL`, and `VITE_META_WORKER_URL` are
required at build time. `VITE_REC_WORKER_URL` (ricochet) is optional — the app
degrades gracefully without it. See `news-feed/.env.example` for local ports.

## Local development

### Prerequisites

- **Node.js 22+** (required for `--experimental-strip-types` in `news-feed` tests)
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (`npm i -g wrangler`)

### 1. Install dependencies

```bash
make install
```

### 2. Set up environment

```bash
cp news-feed/.env.example news-feed/.env
```

### 3. Start the platform worker (required) + frontend

```bash
make worker-platform   # terminal 1 → http://localhost:8787
make dev               # terminal 2 → http://localhost:5173/
```

All domains (RSS, sync, meta, rec) run on the unified **platform-worker**. Set `VITE_PLATFORM_WORKER_URL` in `news-feed/.env` (see `.env.example`).

### Makefile quick reference

| Target | What it does |
|--------|-------------|
| `make` / `make dev` | Vite dev server → http://localhost:5173/ |
| `make preview-pages` | GitHub Pages–style build + preview → http://localhost:4173/boomerang |
| `make worker-platform` | platform-worker (RSS, sync, meta, rec) → http://localhost:8787 |
| `make stop-worker-platform` | Stop the local platform-worker on port 8787 |
| `make install` | `npm ci` in all four packages |
| `make test` | Tests in all four packages |
| `make deploy` | Deploy rss + sync + meta workers |
| `make deploy-rss/sync/meta` | Deploy individual workers |
| `make create-kv` | One-time: create ARTICLE_META KV namespace |
| `make create-r2` | One-time: create boomerang R2 bucket |

## Repo layout

| Path | What it is |
|------|------------|
| `news-feed/` | React + Vite PWA. Storage: native IndexedDB (`boomerang-kv` DB). GitHub Pages base path `/boomerang` when `GITHUB_PAGES=true`. |
| `rss-worker/` | RSS bundle + og-image proxy. |
| `meta-worker/` | Shared article metadata — KV-backed, DO-coordinated. |
| `sync-worker/` | R2-backed room sync for prefs, bookmarks, and labels. |
| `shared/rss-sources.json` | Canonical built-in RSS source list (imported at build by `news-feed` and `rss-worker`). |
| `docs/` | Feature design docs (design → PRD → plan → TDD log per feature slug). |

## Deploy

### Frontend

GitHub Actions (`.github/workflows/deploy.yml`) builds `news-feed/` on push to
`main` and publishes `news-feed/dist` to **GitHub Pages**.

Required repository variables (no trailing slashes):

| Variable | Required | Notes |
|----------|----------|-------|
| `VITE_RSS_WORKER_URL` | ✅ | RSS bundle worker |
| `VITE_SYNC_WORKER_URL` | ✅ | Cross-device sync worker |
| `VITE_META_WORKER_URL` | ✅ | Shared article tags worker |
| `VITE_REC_WORKER_URL` | optional | Ricochet rec worker — app works without it |
| `CANONICAL_URL` | optional | If set, skips app build and emits a redirect-only `index.html` |

### Workers

```bash
make deploy         # rss + sync + meta
make deploy-rss     # rss-worker only
make deploy-sync    # sync-worker only
make deploy-meta    # meta-worker only
# ricochet: cd /path/to/ricochet && npm run deploy
```

## Cost guardrails (Cloudflare free tier)

- **Durable Objects**: ~100k requests/day free. The metadata read path (`GET /meta`)
  reads KV directly and does not hit the DO. Normal browsing keeps DO usage near zero.
- Only explicit tag submissions (`POST /meta/tags`) touch the `meta-worker` DO.
- Validate after deploy: `wrangler tail meta-worker` — no DO exceptions during normal browsing.
