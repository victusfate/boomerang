# Requires GNU Make (Git for Windows: add Git's usr\bin to PATH, or use Git Bash).
# Default: Vite dev server (loads news-feed/.env for VITE_* worker URLs).

.PHONY: help preview-pages run dev worker-platform stop-worker-platform \
        install audit test test-integration \
        deploy-platform deploy \
        create-kv create-r2 create-rec-kv

.DEFAULT_GOAL := dev

# npm 11 treats npm_config_devdir as an unknown env config; remove it for make targets.
unexport npm_config_devdir
unexport NPM_CONFIG_DEVDIR

help:
	@echo "Boomerang — common targets"
	@echo ""
	@echo "Dev"
	@echo "  make / make dev / make run  Vite dev — http://localhost:5173/ (uses .env)"
	@echo "  make preview-pages           GitHub Pages–style build + preview → http://localhost:4173/boomerang"
	@echo "  (no make on Windows PS?)    npm run dev --prefix news-feed  /  npm run preview:gh-pages --prefix news-feed"
	@echo "  make worker-platform       wrangler dev — platform-worker http://localhost:8787"
	@echo "  make stop-worker-platform  kill local platform-worker listener (8787)"
	@echo "  make install               npm ci in news-feed and platform-worker"
	@echo "  make audit                 npm audit fix + npm audit in both packages"
	@echo "  make test                  Run tests in news-feed"
	@echo ""
	@echo "Deploy (requires wrangler login)"
	@echo "  make deploy-platform       Deploy platform-worker to Cloudflare"
	@echo "  make deploy                alias for deploy-platform"
	@echo ""
	@echo "One-time resource creation (run once per Cloudflare account)"
	@echo "  make create-kv             Create ARTICLE_META KV namespace"
	@echo "  make create-r2             Create boomerang R2 bucket"
	@echo "  make create-rec-kv         Create REC_STORE KV namespace"

# ── Frontend ──────────────────────────────────────────────────────────────────

preview-pages:
	cd news-feed && npm run preview:gh-pages

run: dev

dev:
	npm run dev --prefix news-feed

# ── Worker dev server ─────────────────────────────────────────────────────────

worker-platform:
	cd platform-worker && npx wrangler dev --port 8787

stop-worker-platform:
	@pids="$$(lsof -t -iTCP:8787 -sTCP:LISTEN 2>/dev/null || true)"; \
	if [ -n "$$pids" ]; then \
		echo "Stopping platform-worker on :8787 (pid(s): $$pids)"; \
		kill $$pids; \
	else \
		echo "platform-worker is not listening on :8787"; \
	fi

# ── Install + test ────────────────────────────────────────────────────────────

install:
	cd news-feed && npm ci
	cd platform-worker && npm ci

audit:
	cd news-feed && npm audit fix; npm audit || true
	cd platform-worker && npm audit fix; npm audit || true

test:
	cd news-feed && npm test
	cd platform-worker && npm test

test-integration: ## Run integration tests against local wrangler dev (start with: make worker-platform)
	npm run test:integration

# ── Deploy ────────────────────────────────────────────────────────────────────

deploy-platform:
	cd platform-worker && npx wrangler deploy

deploy: deploy-platform

# ── One-time resource creation ────────────────────────────────────────────────
# Run these once when setting up a new Cloudflare account.
# After creation, paste the returned namespace/bucket id into platform-worker/wrangler.jsonc.

create-kv:
	@echo "Creating ARTICLE_META KV namespace..."
	cd platform-worker && npx wrangler kv namespace create "ARTICLE_META"
	@echo "Paste the returned id into platform-worker/wrangler.jsonc → kv_namespaces (ARTICLE_META binding)"

create-r2:
	@echo "Creating boomerang R2 bucket..."
	cd platform-worker && npx wrangler r2 bucket create boomerang
	@echo "Bucket 'boomerang' created — no config change needed (name is hardcoded in wrangler.jsonc)"

create-rec-kv:
	@echo "Creating REC_STORE KV namespace..."
	cd platform-worker && npx wrangler kv namespace create "REC_STORE"
	@echo "Paste the returned id into platform-worker/wrangler.jsonc → kv_namespaces (REC_STORE binding)"
