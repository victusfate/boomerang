# Boomerang — Claude Code Guidelines

## Repository layout

| Path | What it is |
|---|---|
| `shared/rss-sources.json` | Canonical built-in RSS source list — imported at build by `news-feed` and `platform-worker` |
| `news-feed/` | News PWA (React + Vite + Fireproof), deployed to GitHub Pages at `/boomerang` |
| `platform-worker/` | **Unified Cloudflare Worker** — all four domains in one deploy: RSS (`/bundle`, `/og-image`, `/image`), sync (`/sync/*`), meta (`/meta*`, `/ws`), rec (`/interactions`, `/recommendations/*`). Local dev: port **8791** (`make worker-platform`). |
| `.github/workflows/deploy.yml` | Builds `news-feed/` only; uploads `news-feed/dist` |
| `/` (repo root) | `npm run dev` / `preview` forward to `news-feed/`. **`npm run build`** runs `npm ci` + build in `news-feed/` (same as Cloudflare Pages from repo root). In **`news-feed`**, **`npm run preview:gh-pages`** = GitHub Pages–style build + preview (`http://localhost:4173/boomerang`). **`make`** defaults to Vite dev (`http://localhost:5173/`); **`make preview-pages`** runs the GH Pages preview (needs GNU Make). **`make test`** runs tests in `news-feed`. |

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
   (from repo root — `npm ci` + build in `news-feed`) or `cd news-feed && npm run build` to rebuild without `npm ci`
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
- **Storage**: Fireproof (`use-fireproof ^0.24.0`) — database name `boomerang-news`
  - `user-prefs` document: topic weights, seenIds, readIds, savedIds, source/topic toggles
  - `feed-cache` document: last ranked article list + fetchedAt timestamp
- **RSS fetching**: **Cloudflare Worker only** (`platform-worker`). **Required** at build/dev: `VITE_PLATFORM_WORKER_URL` (no trailing slash). GitHub Actions must set repository variable **`VITE_PLATFORM_WORKER_URL`**. Worker exposes `GET /bundle?include=id1,id2,...`. There is no browser RSS or CORS-proxy fallback. Local dev: `make worker-platform` (port **8791**); see `news-feed/.env.example`.
- **Shared article metadata**: `platform-worker` — real-time WebSocket updates (`GET /ws`) and KV-backed tags (`GET /meta`, `POST /meta/tags`). Client hook: `useMetaWorker`.
- **Sync**: `platform-worker` (`/sync/*`) — cross-browser preferences and bookmarks sync. URL fragment carries `roomId:token:workerUrl`; token is never sent in query strings. Client hook: `useSyncWorker` (polls 30s + visibilitychange, debounced push, 412 conflict retry). R2 bucket: `boomerang`.
- **Recommendations**: `platform-worker` (`/interactions`, `/recommendations/:userId`) via `@victusfate/ricochet`. Client hook: `useRecWorker`.
- **PWA**: `vite-plugin-pwa`

## Tech stack — platform-worker

- **Runtime**: Cloudflare Workers + R2 (`SYNC_BLOCKS`, bucket `boomerang`) + KV (`ARTICLE_META`, `REC_STORE`) + Durable Objects (`META_DO` global WebSocket hub, `REC_DO` global rec model)
- **Routes**: `GET /bundle`, `/og-image`, `/image` (RSS) · `/sync/*` (sync) · `/meta`, `/meta/tags`, `/ws` (meta) · `/interactions`, `/recommendations/:userId` (rec)
- **Scheduled**: hourly cron → `META_DO /prune` + `REC_DO /prune`
- **Deploy**: `make deploy-platform` (`cd platform-worker && wrangler deploy`)

## Key behaviours to preserve

- **Progressive loading**: 5 articles at a time, `IntersectionObserver` sentinel auto-loads more
- **Seen tracking**: articles rendered in the feed are written to `seenIds` in Fireproof; filtered out on next refresh
- **Worker fetch + `onBatch`**: `fetchAllSources` talks to `platform-worker` only (no browser RSS). The client still uses `onBatch` as the merged article pool grows (e.g. fast-tier + background-tier paths), not per-source browser streaming.
- **Fireproof cache**: cold starts show the cached feed instantly, then refresh in background
- **YouTube thumbnails**: extracted from watch URLs via `img.youtube.com/vi/{id}/hqdefault.jpg`; `media:thumbnail` also parsed for Atom feeds
- **Lazy og:image**: cards without RSS images fetch `og:image` via CORS proxy when scrolled into view

---

# Claude Code Workflow — Design → PRD → Plan → TDD

End-to-end feature work follows four **local** doc steps below. The flow is the
same idea as “stress-test the design → PRD → vertical-slice plan → TDD”, but
this repo does **not** rely on external skill packages—only the files under
`./docs/<feature-slug>/`.

## Session Start

On your first response in a new session, check whether this project has a
`./docs/` folder with feature artifacts (`design.md`, `prd.md`, `plan.md`).

- If yes, just acknowledge and continue normally.
- If no, ask once: "Want me to scaffold the design → PRD → plan → TDD workflow
  for the next feature, or are we doing something else today?"

Don't ask again in the same session. Don't ask if the user opens with a
specific request — just handle the request.

## Minimum Viable Diff (Applies to All Code Changes)

Prefer the smallest change that achieves the goal. This rule overrides
any tendency to "improve things while you're in there."

- **Make single, targeted edits.** Do not rewrite functions, files, or
  modules when a few-line change works.
- **Preserve existing structure, naming, and patterns** unless the user
  explicitly asks for a rewrite, or the existing code actively blocks
  the requested change.
- **No opportunistic refactors.** If you spot an improvement that isn't
  required by the current change, surface it as a separate suggestion
  — don't bundle it into the diff.
- **No style-preference rewrites.** Working code stays as-is even if
  you'd write it differently.
- **In TDD GREEN:** write the smallest code that makes the test pass,
  not the most elegant.
- **In TDD REFACTOR:** only refactor what the new test exposed. Out-of-
  scope refactors go in a separate commit or a separate session.
- **When in doubt, ask** before producing a diff larger than ~30 lines
  for a feature that should be small.

## The Chain (Auto-Run Unless I Say Otherwise)

When I share a plan, design, or feature idea, run this chain end-to-end
without asking permission between steps:

1. **Design (Q&A and domain)** — Interview one question at a time with your
   recommended answer until the design tree is resolved. Stress-test vague or
   overloaded terms; align with the codebase where facts matter. Capture in
   `design.md`: Q&A summary, decisions, edge-case scenarios, and a **canonical
   vocabulary** (terms to use consistently in later docs and code).

2. **PRD** — Skip repeating problem discovery if `design.md` already covered it.
   Explore the codebase to verify claims. Sketch deep modules with simple,
   testable interfaces. Use the canonical terms from `design.md`. Write
   `prd.md`: problem, solution, numbered user stories, implementation decisions,
   testing strategy, out-of-scope.

3. **Plan** — Break the PRD into **tracer-bullet vertical slices** (each slice
   cuts through all layers end-to-end: data/schema → logic → UI → tests—not
   horizontal layers alone). Prefer extending existing code over replacing it
   (minimum viable diff). Output `plan.md` only (no issue-tracker export
   required). Confirm granularity once before coding.

4. **TDD** — Execute `plan.md` one slice at a time: RED → GREEN → REFACTOR if
   needed. Maintain `tdd-log.md` with per-slice status (pending, red, green,
   refactor, done).

**Skip ahead** if I say "skip to <step>".
**Stop** the chain if I say "stop", "no chain", or "just answer".

## Artifacts — One Folder Per Feature

All artifacts live in `./docs/<feature-slug>/` where `<feature-slug>` is
kebab-case derived from the topic. State the slug you're using before
writing the first file so I can correct it in one word.

```
./docs/<feature-slug>/
  ├── design.md      # Q&A, decisions, scenarios, canonical vocabulary
  ├── prd.md         # full PRD
  ├── plan.md        # vertical slices (local plan—not a ticket export)
  └── tdd-log.md     # per-slice TDD status and notes
```

If the working directory isn't a git repo, write the files anyway and
skip the commit steps below.

## Git Commits — One Per Step

After each step writes its artifact, commit it before moving on. Use
conventional-commit-style messages:

- `docs(<slug>): design Q&A and vocabulary`
- `docs(<slug>): PRD`
- `docs(<slug>): implementation plan`

For TDD, commit per phase per slice so reverts are clean:

- `test(<slug>): slice N red — <behavior>`
- `feat(<slug>): slice N green — <behavior>`
- `refactor(<slug>): slice N — <what changed>` (only if refactor happened)

After each TDD commit, append the slice's status to `tdd-log.md` in the
same commit.

Keep commit diffs scoped to the slice. If a "small change" balloons
into something large, stop and surface that — don't quietly absorb the
extra scope.

## Retry Semantics

Each step's input is the prior step's artifact, so any stage is
independently retryable:

- **Bad TDD slice** → revert that slice's commits, re-run tdd from
  `plan.md` slice N.
- **Plan feels off** → re-plan from `prd.md` into `plan.md`.
- **PRD missed something** → re-write `prd.md` from `design.md`, or extend
  `design.md` and then PRD.
- **Terms drift** → update the vocabulary section in `design.md`, then align
  `prd.md` / `plan.md` if needed.

## What This Doesn't Apply To

Don't run the chain for any of these — just do the work directly
(while still respecting the minimum-viable-diff rule):

- Bug fixes under ~10 lines
- One-off scripts or throwaway prototypes
- Config edits, dependency bumps, lint fixes
- Doc-only changes
- Anything where I explicitly say "just write it", "no tests", or
  "quick fix"

## Notes

- Feature-slug rule: kebab-case, drop articles ("the", "a"), keep it
  under ~30 chars. Example: "combat resolution system" →
  `combat-resolution`.
- Use the **canonical vocabulary** section in `design.md` before introducing
  new domain terms in conversation, code, or commits. If a new term emerges,
  update `design.md` first, then propagate to PRD/plan as needed.
- Older feature folders may still use `grill-me.md` and
  `UBIQUITOUS_LANGUAGE.md`; for new work prefer `design.md` (merge glossary
  into that file). When extending an old folder, keep its existing names or
  consolidate in a follow-up edit—don’t duplicate both styles in one folder.
- The chain can run long. If context starts feeling thin mid-chain,
  flag it and suggest splitting into a fresh session at the next clean
  boundary (between slices is ideal).

## Cursor Cloud specific instructions

### Node.js

This project requires **Node.js 22+** (for `--experimental-strip-types` in `news-feed` tests). The update script installs Node 22 via nodesource.

### Quick reference

| Action | Command |
|---|---|
| Install all deps | `make install` (runs `npm ci` in all 6 packages) |
| Run all tests | `make test` |
| Typecheck news-feed | `cd news-feed && npm run typecheck` |
| Typecheck platform-worker | `cd platform-worker && npm run typecheck` |
| Build news-feed | `npm run build` (from repo root) |
| Dev server (frontend) | `make dev` → http://localhost:5173/ |
| Dev server (platform-worker) | `make worker-platform` → http://127.0.0.1:8791 |

### Environment setup

Copy `news-feed/.env.example` → `news-feed/.env` before running the frontend dev server. The example sets `VITE_PLATFORM_WORKER_URL=http://127.0.0.1:8791`.

### Running services for local dev

- **`platform-worker`** is required for the frontend to load articles (RSS, sync, meta, rec — all on port **8791**). Start with `make worker-platform`.
- Workers run via `wrangler dev` and don't need Cloudflare API tokens for local use.

### Gotchas

- There is no root `package-lock.json`. Each sub-package has its own lockfile; install them individually or via `make install`.
- The `npm run build` from root runs `npm ci --prefix news-feed` which reinstalls news-feed deps. If you've already installed, `cd news-feed && npm run build` is faster.
- `punycode` deprecation warnings in worker tests are harmless noise from wrangler internals.
- The `news-feed` test command uses Node's built-in test runner (not Vitest).
