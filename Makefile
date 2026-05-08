# Requires GNU Make (Git for Windows: add Git's usr\bin to PATH, or use Git Bash).
# Default: Vite dev server (loads news-feed/.env for VITE_* worker URLs).

.PHONY: help preview-pages run dev worker worker-meta worker-sync worker-rss worker-rec install test \
        deploy-rss deploy-sync deploy-meta deploy-rec deploy \
        create-kv create-r2 create-rec-kv

.DEFAULT_GOAL := dev

help:
	@echo "Boomerang — common targets"
	@echo ""
	@echo "Dev"
	@echo "  make / make dev / make run  Vite dev — http://localhost:5173/ (uses .env)"
	@echo "  make preview-pages           GitHub Pages–style build + preview → http://localhost:4173/boomerang"
	@echo "  (no make on Windows PS?)    npm run dev --prefix news-feed  /  npm run preview:gh-pages --prefix news-feed"
	@echo "  make worker-rss            wrangler dev — rss-worker  http://127.0.0.1:8787"
	@echo "  make worker-sync           wrangler dev — sync-worker  http://127.0.0.1:8788"
	@echo "  make worker-meta           wrangler dev — meta-worker  http://127.0.0.1:8789"
	@echo "  make worker-rec            wrangler dev — rec-worker   http://127.0.0.1:8790"
	@echo "  make worker                alias for worker-rss (backwards compat)"
	@echo "  make install               npm ci in all five packages"
	@echo "  make test                  Run tests in all four packages"
	@echo ""
	@echo "Deploy (requires wrangler login)"
	@echo "  make deploy-rss            Deploy rss-worker to Cloudflare"
	@echo "  make deploy-sync           Deploy sync-worker to Cloudflare"
	@echo "  make deploy-meta           Deploy meta-worker to Cloudflare"
	@echo "  make deploy-rec            Deploy rec-worker to Cloudflare"
	@echo "  make deploy                Deploy all four workers"
	@echo ""
	@echo "One-time resource creation (run once per Cloudflare account)"
	@echo "  make create-kv             Create ARTICLE_META KV namespace (meta-worker)"
	@echo "  make create-r2             Create boomerang R2 bucket (sync-worker)"
	@echo "  make create-rec-kv         Create REC_STORE KV namespace (rec-worker)"

# ── Frontend ──────────────────────────────────────────────────────────────────

preview-pages:
	cd news-feed && npm run preview:gh-pages

run: dev

dev:
	npm run dev --prefix news-feed

# ── Worker dev servers ────────────────────────────────────────────────────────

worker-rss:
	cd rss-worker && npx wrangler dev --port 8787

worker-sync:
	cd sync-worker && npx wrangler dev --port 8788

worker-meta:
	cd meta-worker && npx wrangler dev --port 8789

worker-rec:
	cd rec-worker && npx wrangler dev --port 8790

worker: worker-rss

# ── Install + test ────────────────────────────────────────────────────────────

install:
	cd news-feed && npm ci
	cd rss-worker && npm ci
	cd sync-worker && npm ci
	cd meta-worker && npm ci
	cd rec-worker && npm ci

test:
	cd news-feed && npm test
	cd rss-worker && npm test
	cd sync-worker && npm test
	cd meta-worker && npm test

# ── Deploy ────────────────────────────────────────────────────────────────────

deploy-rss:
	cd rss-worker && npx wrangler deploy

deploy-sync:
	cd sync-worker && npx wrangler deploy

deploy-meta:
	cd meta-worker && npx wrangler deploy

deploy-rec:
	cd rec-worker && npx wrangler deploy

deploy: deploy-rss deploy-sync deploy-meta deploy-rec

# ── One-time resource creation ────────────────────────────────────────────────
# Run these once when setting up a new Cloudflare account.
# After creation, paste the returned namespace/bucket id into the relevant wrangler.jsonc.

create-kv:
	@echo "Creating ARTICLE_META KV namespace for meta-worker..."
	cd meta-worker && npx wrangler kv namespace create "ARTICLE_META"
	@echo "Paste the returned id into meta-worker/wrangler.jsonc → kv_namespaces[0].id"
	@echo "Also paste it into rss-worker/wrangler.jsonc → kv_namespaces[0].id"

create-r2:
	@echo "Creating boomerang R2 bucket for sync-worker..."
	cd sync-worker && npx wrangler r2 bucket create boomerang
	@echo "Bucket 'boomerang' created — no config change needed (name is hardcoded in wrangler.jsonc)"

create-rec-kv:
	@echo "Creating REC_STORE KV namespace for rec-worker..."
	cd rec-worker && npx wrangler kv namespace create "REC_STORE"
	@echo "Paste the returned id into rec-worker/wrangler.jsonc → kv_namespaces[0].id"
