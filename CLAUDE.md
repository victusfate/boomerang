# Boomerang — Claude Code Guidelines

## Repository layout

| Path | What it is |
|---|---|
| `news-feed/` | News PWA (React + Vite + Fireproof), deployed to GitHub Pages at `/boomerang` |
| `rss-worker/` | Cloudflare Worker — RSS aggregation (`GET /bundle`), staggered upstream fetches |
| `.github/workflows/deploy.yml` | Builds `news-feed/` only; uploads `news-feed/dist` |
| `/` (repo root) | `npm run dev` / `build` / `preview` forward to `news-feed/`. **`npm run preview:gh-pages`** = GitHub Pages–style build + preview (`http://localhost:4173/boomerang`). **`make`** same (needs GNU Make). |

## PR workflow — always follow this order

1. **Pull latest main first**
   ```
   git checkout main && git pull origin main
   ```
2. **Create a clean branch from main**
   ```
   git checkout -b claude/<short-descriptive-name>
   ```
3. **Do the work, then build to verify**
   ```
   npm run build
   ```
   (from repo root — forwards to `news-feed`) or `cd news-feed && npm run build`
4. **Commit with a clear message, push the branch**
   ```
   git push -u origin claude/<branch-name>
   ```
5. **Create the PR via GitHub MCP tools** (`mcp__github__create_pull_request`)
   - owner: `victusfate`, repo: `boomerang`
   - base: `main`, head: `claude/<branch-name>`
6. **After the user merges**, pull main again:
   ```
   git checkout main && git pull origin main
   ```

> Never commit directly to main for feature work. Never reuse an old branch for a new PR.

## Tech stack — news-feed

- **Framework**: React 18 + Vite + TypeScript
- **Storage**: Fireproof (`use-fireproof ^0.19.0`) — database name `boomerang-news`
  - `user-prefs` document: topic weights, seenIds, readIds, savedIds, source/topic toggles
  - `feed-cache` document: last ranked article list + fetchedAt timestamp
- **RSS fetching**: **Cloudflare Worker only** (`rss-worker/`). Set `VITE_RSS_WORKER_URL` at build time (no trailing slash), e.g. `https://boomerang-rss.boomerang.workers.dev` — that is `https://<wrangler-name>.<account-subdomain>.workers.dev` (not the bare account URL `https://boomerang.workers.dev`). GitHub Actions reads **repository variable** `VITE_RSS_WORKER_URL`. Worker exposes `GET /bundle?include=id1,id2,...`. There is no browser RSS or CORS-proxy fallback; local dev uses `VITE_RSS_WORKER_URL=http://127.0.0.1:8787` with `wrangler dev`.
- **PWA**: `vite-plugin-pwa`

## Key behaviours to preserve

- **Progressive loading**: 5 articles at a time, `IntersectionObserver` sentinel auto-loads more
- **Seen tracking**: articles rendered in the feed are written to `seenIds` in Fireproof; filtered out on next refresh
- **Streaming fetch**: With CORS fallback, `fetchAllSources` streams per source via `onBatch`. With the Worker, one response updates the feed.
- **Fireproof cache**: cold starts show the cached feed instantly, then refresh in background
- **YouTube thumbnails**: extracted from watch URLs via `img.youtube.com/vi/{id}/hqdefault.jpg`; `media:thumbnail` also parsed for Atom feeds
- **Lazy og:image**: cards without RSS images fetch `og:image` via CORS proxy when scrolled into view
