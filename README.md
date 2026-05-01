# Boomerang News

Algorithmic RSS news feed — React PWA backed by several Cloudflare Workers.

Live at [boomerang-news.com](https://boomerang-news.com)

## Cloudflare Workers

| Package | Role |
|---------|------|
| **`rss-worker/`** | Aggregates configured RSS feeds into **`GET /bundle`** (staggered upstream fetches). Reads shared **KV** so each item can include **tags** written by meta-worker. Serves **`/og-image`** for lazy card images. |
| **`meta-worker/`** | **Global** per-article metadata (e.g. AI-derived tags). One **Durable Object** + **WebSocket** at **`GET /ws`** for subscribe / catch-up; **KV** is shared with `rss-worker` so cold loads get tags inline in the bundle. |
| **`sync-worker/`** | **Private** cross-device sync: **R2** stores Fireproof-style blocks and a small room **meta** doc. Create room via **`POST /sync/room`**; clients send **`Authorization: Bearer`** on writes; the share link keeps the raw token in the **URL hash** only. |

The PWA requires all three worker base URLs at build time (`VITE_RSS_WORKER_URL`, `VITE_META_WORKER_URL`, `VITE_SYNC_WORKER_URL`). See `news-feed/.env.example` for local ports and GitHub repository variables for deploys.

## Local development

### Prerequisites

- Node.js 20+
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (`npm i -g wrangler`)

### 1. Install dependencies

```bash
npm ci --prefix news-feed
npm ci --prefix rss-worker
```

### 2. Start the RSS worker

```bash
cd rss-worker
wrangler dev
# listening on http://127.0.0.1:8787
```

### 3. Start the news feed

In a second terminal, copy `.env.example` to `.env` (it sets all three worker URLs for local ports), then:

```bash
cd news-feed
npm run dev
# http://localhost:5173
```

To exercise **sync** and **shared tags** locally, run `meta-worker` and `sync-worker` on the ports in `.env.example` (see comments there).

## Repo layout

| Path | What it is |
|---|---|
| `news-feed/` | React + Vite PWA (GitHub Pages base path `/boomerang` when built with `GITHUB_PAGES=true`) |
| `rss-worker/` | RSS bundle + og-image proxy |
| `meta-worker/` | Shared article metadata (DO + KV + WebSocket) |
| `sync-worker/` | R2-backed room sync for prefs / bookmarks / labels |
| `shared/rss-sources.json` | Canonical built-in RSS source list (imported at build by the feed and `rss-worker`) |

## Deploy

- **Frontend**: GitHub Actions — on push to `main`, `.github/workflows/deploy.yml` builds `news-feed/` and publishes `news-feed/dist` to **GitHub Pages**. Set repository variables **`VITE_RSS_WORKER_URL`**, **`VITE_SYNC_WORKER_URL`**, and **`VITE_META_WORKER_URL`** (no trailing slashes); if any are missing, the built app will show configuration errors until they are set and the site is rebuilt. **`CANONICAL_URL`**, if set, skips the app build and emits a redirect-only `index.html`.
- **Workers**: Deploy separately with Wrangler, e.g. `cd rss-worker && npx wrangler deploy` (and the same pattern for `sync-worker/`, `meta-worker/`). See root **`Makefile`** for `deploy-rss`, `deploy-sync`, `deploy-meta`, and `deploy` (all three).
