# Boomerang — Claude Code Guidelines

## Repository layout

| Path | What it is |
|---|---|
| `shared/rss-sources.json` | Canonical built-in RSS source list — imported at build by `news-feed` and `rss-worker` |
| `news-feed/` | News PWA (React + Vite + Fireproof), deployed to GitHub Pages at `/boomerang` |
| `rss-worker/` | Cloudflare Worker — RSS aggregation (`GET /bundle`), staggered upstream fetches |
| `sync-worker/` | Cloudflare Worker — cross-browser sync via R2 (`POST /sync/room`, `PUT/GET /sync/{roomId}/meta`, `PUT/GET /sync/{roomId}/blocks/{cid}`, `DELETE /sync/{roomId}`). Token auth: SHA-256(token) stored in R2; raw token travels only in the URL fragment, never in query strings. |
| `.github/workflows/deploy.yml` | Builds `news-feed/` only; uploads `news-feed/dist` |
| `/` (repo root) | `npm run dev` / `preview` forward to `news-feed/`. **`npm run build`** runs `npm ci` + build in `news-feed/` (same as Cloudflare Pages from repo root). In **`news-feed`**, **`npm run preview:gh-pages`** = GitHub Pages–style build + preview (`http://localhost:4173/boomerang`). **`make`** same (needs GNU Make). **`make test`** runs tests in all three packages. |

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
- **RSS fetching**: **Cloudflare Worker only** (`rss-worker/`). Set `VITE_RSS_WORKER_URL` at build time (no trailing slash), e.g. `https://boomerang-rss.boomerang.workers.dev` — that is `https://<wrangler-name>.<account-subdomain>.workers.dev` (not the bare account URL `https://boomerang.workers.dev`). GitHub Actions reads **repository variable** `VITE_RSS_WORKER_URL`. Worker exposes `GET /bundle?include=id1,id2,...`. There is no browser RSS or CORS-proxy fallback; local dev uses `VITE_RSS_WORKER_URL=http://127.0.0.1:8787` with `wrangler dev`.
- **Sync**: `sync-worker/` — cross-browser preferences and bookmarks sync. Set `VITE_SYNC_WORKER_URL` at build time; defaults to `https://boomerang-sync.boomerang.workers.dev` in production builds. URL fragment carries `roomId:token:workerUrl`; token is never sent in query strings. Client hook: `useSyncWorker` (polls 30s + visibilitychange, debounced push, 412 conflict retry). R2 bucket name: `boomerang`.
- **PWA**: `vite-plugin-pwa`

## Tech stack — sync-worker

- **Runtime**: Cloudflare Workers + R2 (bucket binding: `SYNC_BLOCKS`, bucket name: `boomerang`)
- **Auth**: Bearer token in `Authorization` header; SHA-256 hash stored at `{roomId}/token` in R2
- **Routes**: `POST /sync/room` (create), `GET|PUT /sync/{roomId}/meta` (clock head + ETag/If-Match), `GET|PUT /sync/{roomId}/blocks/{cid}` (block store), `DELETE /sync/{roomId}` (revoke)
- **Tests**: Vitest 4 + `@cloudflare/vitest-pool-workers` (`src/worker.test.ts`); config in `vitest.config.mts`
- **Deploy**: `cd sync-worker && wrangler deploy`; create bucket once with `wrangler r2 bucket create boomerang`

## Key behaviours to preserve

- **Progressive loading**: 5 articles at a time, `IntersectionObserver` sentinel auto-loads more
- **Seen tracking**: articles rendered in the feed are written to `seenIds` in Fireproof; filtered out on next refresh
- **Streaming fetch**: With CORS fallback, `fetchAllSources` streams per source via `onBatch`. With the Worker, one response updates the feed.
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
