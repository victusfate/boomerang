# Boomerang RSS Worker

## Setup

```bash
cd rss-worker
npm install
npx wrangler login
```

## Develop

```bash
npm run dev
```

Open `http://127.0.0.1:8787/health` and `http://127.0.0.1:8787/bundle`.

## Deploy

```bash
npm install   # required so fast-xml-parser and other deps resolve
npm run deploy
```

Run these commands **from this directory** (`rss-worker/`), not the repo root.

After deploy, Wrangler prints the Worker URL. It looks like `https://boomerang-rss.<account-subdomain>.workers.dev` (see `wrangler.jsonc` `name`). Set that value as **`VITE_RSS_WORKER_URL`** in `news-feed/.env` locally and as a GitHub **Actions variable** for Pages builds — **not** the bare account subdomain page alone (`https://boomerang.workers.dev`).
