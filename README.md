# Boomerang News

Algorithmic RSS news feed — React PWA backed by a unified Cloudflare Worker.

Live at [boomerang-news.com](https://boomerang-news.com)

## Architecture

The frontend (`news-feed/`) is a React + Vite PWA that stores all user state
locally in **native IndexedDB** (via a thin `kvStore.ts` wrapper). A single
**platform-worker** handles all server-side concerns across four domains:

| Domain | Routes | Role |
|--------|--------|------|
| **RSS** | `GET /bundle` · `GET /og-image` · `GET /image` | Aggregates built-in and custom RSS feeds (staggered fetches, full HTML5 entity decoding). `og-image` proxies lazy card thumbnails. `image` proxies article images. On each `/bundle` response, article metadata (title, source, URL) is written to `ARTICLE_META` KV via `ctx.waitUntil` for later title resolution. |
| **Meta** | `GET /meta` · `POST /meta/tags` · `GET /ws` | Per-article shared metadata. Bulk KV reads on `GET /meta`; batched AI-tag writes on `POST /meta/tags`. One global Durable Object (`MetaDO`, SQLite-backed) coordinates real-time tag broadcasts over `GET /ws` WebSocket. |
| **Sync** | `POST /sync/room` · `GET/PUT /sync/{roomId}/meta` · `GET/PUT /sync/{roomId}/blocks/{cid}` | Cross-device sync of prefs, bookmarks, and labels over R2. Share links carry `roomId:token:workerUrl` in the URL fragment — the raw token never travels in query strings. |
| **Rec** | `POST /interactions` · `GET /recommendations/:userId` · `POST /recommendations/:userId` · `GET /rec/articles` | Edge collaborative filtering via [ricochet](https://github.com/victusfate/ricochet). Ingests anonymous interaction events (read, save, upvote, downvote, seen); ranks a feed-pool of candidate article IDs using a global BiasedMF Durable Object (`RecDO`, SQLite). `GET /rec/articles` resolves article titles and metadata by ID from `ARTICLE_META` KV. |

### Cloudflare resources

| Resource | Used by |
|----------|---------|
| **KV `ARTICLE_META`** | Unified per-article store: AI tags + catalog fields (title, source, URL). Written by both Meta (tag updates) and RSS (catalog on bundle fetch). 180-day TTL. |
| **KV `REC_STORE`** | Legacy rec metadata (read-only fallback during migration). |
| **R2 `boomerang`** | Sync room blocks (prefs, bookmarks, labels). |
| **DO `MetaDO`** | Global WebSocket hub for real-time tag updates; SQLite index for catch-up queries. |
| **DO `RecDO`** | Global BiasedMF model; SQLite tables for interactions, user/item factors. |

### Personalisation

Feed ranking combines local signals (recency decay, source diversity) with a
**BiasedMF collaborative filter** (`ŷ = ȳ + bᵤ + bᵢ + ⟨vᵤ, vᵢ⟩`) trained
online from anonymous interaction events. The MF model runs inside `RecDO` and
produces a per-user ranked score for each article in the current feed pool; the
client blends this as a `recBoost` multiplier (×1.0 – ×1.8) on top of the
local recency × diversity score.

- Full scoring pipeline and data-flow diagrams: [`docs/scoring/data-flow.md`](docs/scoring/data-flow.md)
- BiasedMF design and hyperparameters: [ricochet — biased-mf-recs PRD](https://github.com/victusfate/ricochet/blob/main/docs/biased-mf-recs/prd.md)
- HTTP API and type contracts: [ricochet interface reference](https://github.com/victusfate/ricochet/blob/main/docs/ricochet-interface.md)

Cold-start users rank articles by item bias (`bᵢ`) alone — equivalent to
global popularity — and receive personalised boosts as interactions accumulate.

`VITE_PLATFORM_WORKER_URL` is required at build time. The app degrades
gracefully when the rec model has no history (cold-start falls back to
recency × diversity ranking). See `news-feed/.env.example` for local ports.

## Testing

```bash
make test          # unit tests (no browser or worker required)
```

For headless UI tests with Playwright (requires worker + preview server), see **[`docs/testing.md`](docs/testing.md)**.

## Local development

### Prerequisites

- **Node.js 22+** (required for `--experimental-strip-types` in tests)
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

All domains (RSS, sync, meta, rec) run on the unified **platform-worker** on
port **8787**. Set `VITE_PLATFORM_WORKER_URL=http://localhost:8787` in
`news-feed/.env` (see `.env.example`).

### Makefile quick reference

| Target | What it does |
|--------|-------------|
| `make` / `make dev` | Vite dev server → http://localhost:5173/ |
| `make preview-pages` | GitHub Pages–style build + preview → http://localhost:4173/boomerang |
| `make worker-platform` | platform-worker (all domains) → http://localhost:8787 |
| `make stop-worker-platform` | Stop the local platform-worker on port 8787 |
| `make install` | `npm ci` in all packages |
| `make test` | Tests in all packages |
| `make deploy` | Deploy platform-worker |
| `make deploy-platform` | Deploy platform-worker only |
| `make create-kv` | One-time: create `ARTICLE_META` KV namespace |
| `make create-r2` | One-time: create `boomerang` R2 bucket |

## Repo layout

| Path | What it is |
|------|------------|
| `news-feed/` | React + Vite PWA. Storage: native IndexedDB. GitHub Pages base path `/boomerang` when `GITHUB_PAGES=true`. |
| `platform-worker/` | Unified Cloudflare Worker — RSS, sync, meta, and rec domains in one deploy. |
| `shared/rss-sources.json` | Canonical built-in RSS source list (imported at build by both `news-feed` and `platform-worker`). |
| `shared/articleRecordCatalog.ts` | Shared TTL constants and label helpers for the article metadata KV schema. |
| `docs/` | Feature design docs (design → PRD → plan → TDD log per feature slug). Key entry points: [`docs/scoring/data-flow.md`](docs/scoring/data-flow.md) (full scoring pipeline + MF diagrams), [`docs/edge-recommendations/boomerang-context.md`](docs/edge-recommendations/boomerang-context.md) (ricochet integration context). |

## Agent skills

This repo uses [Claude Code scaffold](https://github.com/victusfate/scaffold) skills for structured feature development.
<!-- BEGIN_SKILLS_INVOCATION -->
Skills can also be invoked individually: `/feature-chain`, `/grill-with-docs`, `/to-prd`, `/tdd`, `/design-review`, `/code-quality-review`, `/skillify`, `/sync-scaffold`, `/create-pr`, `/code-review`, `/simplify`, `/prune`, `/pause`, `/resume`, `/hoist-skill`.
<!-- END_SKILLS_INVOCATION -->

### Scaffold layout

<!-- BEGIN_SKILLS_STRUCTURE -->
```
AGENTS.md                        # agent instructions — single source of truth
CLAUDE.md                        # imports AGENTS.md (@AGENTS.md)
GEMINI.md                        # references AGENTS.md
bin/
  bootstrap.sh                   # one-time setup for downstream repos
  sync-from-scaffold.sh          # pull scaffold updates into a downstream repo
.claude/
  skills/
    RESOLVER.md                   # central routing table — skill → regex → path
    feature-chain/SKILL.md        # Orchestrate design → PRD → TDD → review end to end
    grill-with-docs/SKILL.md      # Design Q&A → design.md + canonical vocabulary
    to-prd/SKILL.md               # Synthesize context + codebase → prd.md
    tdd/SKILL.md                  # Vertical-slice TDD → plan.md + tdd-log.md
    design-review/SKILL.md        # Structural review of design.md
    code-quality-review/SKILL.md  # Structural review of implementation
    skillify/SKILL.md             # Capture a completed session as a reusable skill + PR to scaffold
    sync-scaffold/SKILL.md        # Bootstrap scaffold into a repo or sync an existing one from upstream
    create-pr/SKILL.md            # Create a PR for the current branch and immediately subscribe to its activity
    code-review/SKILL.md          # Review current diff for correctness bugs and quality issues at a configurable effort level
    simplify/SKILL.md             # Apply reuse, simplification, efficiency, and altitude cleanups to changed code
    prune/SKILL.md                # Run all quality review skills and funnel findings into design→PRD→TDD→PR
    pause/SKILL.md                # Checkpoint the session into git — write a handoff, commit work in flight, and push so any device can resume
    resume/SKILL.md               # Reload a checkpointed session from the pushed handoff and continue from its next steps, cold or cross-device
    hoist-skill/SKILL.md          # Hoist scaffold capabilities into a consumer repo in the target harness format
  session-start/
    hook.sh                      # SessionStart hook: fetches origin/main, warns if branch is behind
  read-once/
    hook.sh                      # PreToolUse hook: skips redundant file reads
    compact.sh                   # PostCompact hook: clears read cache after compaction
  settings.json                  # hook wiring (SessionStart, PreToolUse, PostCompact)
.cursor/
  rules/
    agents.mdc               # thin pointer to AGENTS.md
    feature-chain.mdc        # mirrors feature-chain for Cursor
    grill-with-docs.mdc      # mirrors grill-with-docs for Cursor
    to-prd.mdc               # mirrors to-prd for Cursor
    tdd.mdc                  # mirrors tdd for Cursor
    design-review.mdc        # mirrors design-review for Cursor
    code-quality-review.mdc  # mirrors code-quality-review for Cursor
    skillify.mdc             # mirrors skillify for Cursor
    sync-scaffold.mdc        # mirrors sync-scaffold for Cursor
    create-pr.mdc            # mirrors create-pr for Cursor
    code-review.mdc          # mirrors code-review for Cursor
    simplify.mdc             # mirrors simplify for Cursor
    prune.mdc                # mirrors prune for Cursor
    pause.mdc                # mirrors pause for Cursor
    resume.mdc               # mirrors resume for Cursor
    hoist-skill.mdc          # mirrors hoist-skill for Cursor
.agents/
  skills/
    feature-chain/SKILL.md        # Orchestrate design → PRD → TDD → review end to end
    grill-with-docs/SKILL.md      # Design Q&A → design.md + canonical vocabulary
    to-prd/SKILL.md               # Synthesize context + codebase → prd.md
    tdd/SKILL.md                  # Vertical-slice TDD → plan.md + tdd-log.md
    design-review/SKILL.md        # Structural review of design.md
    code-quality-review/SKILL.md  # Structural review of implementation
    skillify/SKILL.md             # Capture a completed session as a reusable skill + PR to scaffold
    sync-scaffold/SKILL.md        # Bootstrap scaffold into a repo or sync an existing one from upstream
    create-pr/SKILL.md            # Create a PR for the current branch and immediately subscribe to its activity
    code-review/SKILL.md          # Review current diff for correctness bugs and quality issues at a configurable effort level
    simplify/SKILL.md             # Apply reuse, simplification, efficiency, and altitude cleanups to changed code
    prune/SKILL.md                # Run all quality review skills and funnel findings into design→PRD→TDD→PR
    pause/SKILL.md                # Checkpoint the session into git — write a handoff, commit work in flight, and push so any device can resume
    resume/SKILL.md               # Reload a checkpointed session from the pushed handoff and continue from its next steps, cold or cross-device
    hoist-skill/SKILL.md          # Hoist scaffold capabilities into a consumer repo in the target harness format
.agent/
  rules/
    agents.md               # thin pointer to AGENTS.md (always-on)
  workflows/
    feature-chain.md        # Orchestrate design → PRD → TDD → review end to end
    grill-with-docs.md      # Design Q&A → design.md + canonical vocabulary
    to-prd.md               # Synthesize context + codebase → prd.md
    tdd.md                  # Vertical-slice TDD → plan.md + tdd-log.md
    design-review.md        # Structural review of design.md
    code-quality-review.md  # Structural review of implementation
    skillify.md             # Capture a completed session as a reusable skill + PR to scaffold
    sync-scaffold.md        # Bootstrap scaffold into a repo or sync an existing one from upstream
    create-pr.md            # Create a PR for the current branch and immediately subscribe to its activity
    code-review.md          # Review current diff for correctness bugs and quality issues at a configurable effort level
    simplify.md             # Apply reuse, simplification, efficiency, and altitude cleanups to changed code
    prune.md                # Run all quality review skills and funnel findings into design→PRD→TDD→PR
    pause.md                # Checkpoint the session into git — write a handoff, commit work in flight, and push so any device can resume
    resume.md               # Reload a checkpointed session from the pushed handoff and continue from its next steps, cold or cross-device
    hoist-skill.md          # Hoist scaffold capabilities into a consumer repo in the target harness format
scripts/
  check-resolvable.mjs           # RESOLVER linter (reachability/ambiguity/DRY/MECE/cursor/antigravity/sync)
  update-readme-skills.mjs       # regenerate README.md skill sections from RESOLVER.md
.githooks/
  pre-commit                     # runs the linter and README freshness check — enable via core.hooksPath
.github/
  scaffold-files.txt             # manifest of files managed by scaffold
  workflows/
    sync-scaffold.yml            # manual workflow to sync updates via PR
.claudeignore                    # excludes build artifacts from Claude's context
```
<!-- END_SKILLS_STRUCTURE -->

## Deploy

### Frontend

GitHub Actions (`.github/workflows/deploy.yml`) builds `news-feed/` on push to
`main` and publishes `news-feed/dist` to **GitHub Pages**.

Required repository variable (no trailing slash):

| Variable | Required | Notes |
|----------|----------|-------|
| `VITE_PLATFORM_WORKER_URL` | ✅ | All worker domains (RSS, sync, meta, rec) |
| `CANONICAL_URL` | optional | If set, skips app build and emits a redirect-only `index.html` |

### Worker

```bash
make deploy-platform   # deploy platform-worker (all domains)
```

## Cost guardrails (Cloudflare free tier)

- **Durable Objects**: ~100k requests/day free. Normal feed browsing reads KV
  directly and does not touch either DO.
- `MetaDO` is only invoked by `POST /meta/tags` (tag writes) and `GET /ws`
  (WebSocket upgrades). Tag writes happen via `ctx.waitUntil` — they do not
  block feed load.
- `RecDO` is invoked on `POST /interactions` and `/recommendations/:userId`.
  KV caches rec responses for 5 minutes; repeated feed loads within that window
  hit KV only.
- Validate after deploy: `wrangler tail platform-worker` — no DO exceptions
  during normal browsing.
