# Boomerang — Claude Code Guidelines

## Repository layout

| Path | What it is |
|---|---|
| `shared/rss-sources.json` | Canonical built-in RSS source list — imported at build by `news-feed` and `rss-worker` |
| `news-feed/` | News PWA (React + Vite + Fireproof), deployed to GitHub Pages at `/boomerang` |
| `rss-worker/` | Cloudflare Worker — RSS aggregation (`GET /bundle`), staggered upstream fetches |
| `.github/workflows/deploy.yml` | Builds `news-feed/` only; uploads `news-feed/dist` |
| `/` (repo root) | `npm run dev` / `preview` forward to `news-feed/`. **`npm run build`** runs `npm ci` + build in `news-feed/` (same as Cloudflare Pages from repo root). In **`news-feed`**, **`npm run preview:gh-pages`** = GitHub Pages–style build + preview (`http://localhost:4173/boomerang`). **`make`** same (needs GNU Make). |

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

---

# Claude Code Workflow — Plan → Glossary → PRD → Plan → TDD

## Session Start

On your first response in a new session, check whether this project has
a `./docs/` folder with feature artifacts (grill-me.md, prd.md, plan.md).

- If yes, just acknowledge and continue normally.
- If no, ask once: "Want me to scaffold the grill-me → glossary → PRD →
  plan → TDD workflow for the next feature, or are we doing something
  else today?"

Don't ask again in the same session. Don't ask if the user opens with a
specific request — just handle the request.

## Required Skills

These five skills must be installed. If any are missing, run:

```bash
npx skills@latest add mattpocock/skills/grill-me
npx skills@latest add mattpocock/skills/ubiquitous-language
npx skills@latest add mattpocock/skills/write-a-prd
npx skills@latest add mattpocock/skills/prd-to-plan
npx skills@latest add mattpocock/skills/tdd
```

## The Chain (Auto-Run Unless I Say Otherwise)

When I share a plan, design, or feature idea, run this chain end-to-end
without asking permission between steps:

1. **grill-me** — Interview me one question at a time, with your
   recommended answer for each, walking each branch of the design tree
   until we reach shared understanding. Then summarize.

2. **ubiquitous-language** — Scan the grill-me Q&A for domain-relevant
   nouns, verbs, and concepts. Flag ambiguities (same word, different
   concepts), synonyms (different words, same concept), and overloaded
   or vague terms. Propose canonical, opinionated term choices. Use
   these terms consistently in every subsequent step.

3. **write-a-prd** — Skip problem capture if grill-me covered it.
   Explore the codebase to verify assertions about current state. Sketch
   deep modules with simple, testable interfaces. Use the canonical
   terms from `UBIQUITOUS_LANGUAGE.md`. Output the full PRD (problem,
   solution, numbered user stories, implementation decisions, testing
   strategy, out-of-scope).

4. **prd-to-plan** — Break the PRD into multi-phase tracer-bullet
   vertical slices. Each phase cuts through ALL integration layers
   end-to-end (schema/data → logic → UI → tests), NOT horizontal layers.
   Briefly confirm granularity once before proceeding.

5. **tdd** — One vertical slice at a time. RED (one test for one
   behavior, confirm it fails) → GREEN (minimal code to pass) → REFACTOR
   if needed. Continue through slices until the plan is complete or I
   stop you.

**Skip ahead** if I say "skip to <step>".
**Stop** the chain if I say "stop", "no chain", or "just answer".

## Artifacts — One Folder Per Feature

All artifacts live in `./docs/<feature-slug>/` where `<feature-slug>` is
kebab-case derived from the topic. State the slug you're using before
writing the first file so I can correct it in one word.

```
./docs/<feature-slug>/
  ├── grill-me.md             # Q&A summary and decisions made
  ├── UBIQUITOUS_LANGUAGE.md  # canonical domain glossary
  ├── prd.md                  # full PRD
  ├── plan.md                 # phased implementation plan (vertical slices)
  └── tdd-log.md              # per-slice status: pending, red, green, refactor, done
```

If the working directory isn't a git repo, write the files anyway and
skip the commit steps below.

## Git Commits — One Per Step

After each step writes its artifact, commit it before moving on. Use
conventional-commit-style messages:

- `docs(<slug>): grill-me Q&A`
- `docs(<slug>): ubiquitous language glossary`
- `docs(<slug>): PRD`
- `docs(<slug>): implementation plan`

For TDD, commit per phase per slice so reverts are clean:

- `test(<slug>): slice N red — <behavior>`
- `feat(<slug>): slice N green — <behavior>`
- `refactor(<slug>): slice N — <what changed>` (only if refactor happened)

After each TDD commit, append the slice's status to `tdd-log.md` in the
same commit.

## Retry Semantics

Each step's input is the prior step's artifact, so any stage is
independently retryable:

- **Bad TDD slice** → revert that slice's commits, re-run tdd from
  `plan.md` slice N.
- **Plan feels off** → re-run prd-to-plan from `prd.md`.
- **PRD missed something** → re-run write-a-prd from `grill-me.md` and
  `UBIQUITOUS_LANGUAGE.md`, or re-grill on the gap and update first.
- **Glossary terms drift** → re-run ubiquitous-language; it will mark
  changed entries with "(updated)" and new entries with "(new)".

## What This Doesn't Apply To

Don't run the chain for any of these — just do the work directly:

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
- Once `UBIQUITOUS_LANGUAGE.md` exists, refer back to it before
  introducing any new domain term in conversation, code, or commits. If
  a new term emerges, re-run ubiquitous-language to incorporate it.
- The chain can run long. If context starts feeling thin mid-chain,
  flag it and suggest splitting into a fresh session at the next clean
  boundary (between slices is ideal).
