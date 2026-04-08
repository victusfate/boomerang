# Boomerang — Claude Code Guidelines

## Repository layout

| Path | What it is |
|---|---|
| `/` | Idea board (React + Vite + Fireproof, deployed to `/boomerang/`) |
| `news-feed/` | Algorithmic news feed PWA (React + Vite + Fireproof, deployed to `/boomerang/` root) |
| `.github/workflows/deploy.yml` | Builds both apps; news feed → root, idea board → `/ideas/` |

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
   cd news-feed && npm run build
   ```
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
- **RSS fetching**: CORS proxy chain — primary `allorigins.win`, fallback `corsproxy.io`
- **PWA**: `vite-plugin-pwa` with StaleWhileRevalidate caching for proxy responses

## Key behaviours to preserve

- **Progressive loading**: 5 articles at a time, `IntersectionObserver` sentinel auto-loads more
- **Seen tracking**: articles rendered in the feed are written to `seenIds` in Fireproof; filtered out on next refresh
- **Streaming fetch**: `fetchAllSources` accepts an `onBatch` callback; UI updates as each source resolves
- **Fireproof cache**: cold starts show the cached feed instantly, then refresh in background
- **YouTube thumbnails**: extracted from watch URLs via `img.youtube.com/vi/{id}/hqdefault.jpg`; `media:thumbnail` also parsed for Atom feeds
- **Lazy og:image**: cards without RSS images fetch `og:image` via CORS proxy when scrolled into view
