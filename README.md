# Boomerang News

Algorithmic RSS news feed — React PWA + Cloudflare Worker backend.

Live at [boomerang-news.com](https://boomerang-news.com)

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

In a second terminal:

```bash
cd news-feed
VITE_RSS_WORKER_URL=http://127.0.0.1:8787 npm run dev
# http://localhost:5173
```

## Repo layout

| Path | What it is |
|---|---|
| `news-feed/` | React + Vite PWA |
| `rss-worker/` | Cloudflare Worker — RSS aggregation |
| `shared/rss-sources.json` | Canonical RSS source list |

## Deploy

- **Frontend**: Cloudflare Pages — auto-deploys from `main` with build command `npm ci --prefix news-feed && npm run build --prefix news-feed`, output `news-feed/dist`, env var `VITE_RSS_WORKER_URL`.
- **Worker**: `cd rss-worker && wrangler deploy`
