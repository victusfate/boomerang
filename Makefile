# Requires GNU Make (Git for Windows: add Git's usr\bin to PATH, or use Git Bash).
# Default: production-like preview at /boomerang (same base as GitHub Pages).

.PHONY: help preview-pages run dev worker install

.DEFAULT_GOAL := preview-pages

help:
	@echo "Boomerang — common targets"
	@echo "  make / make preview-pages  Build news-feed with base /boomerang, then vite preview"
	@echo "  (no make on Windows PS?)    npm run preview:gh-pages   — same as above"
	@echo "  make run                   Same as preview-pages"
	@echo "  make dev                   Vite dev — http://localhost:5173/  (set news-feed/.env for Worker)"
	@echo "  make worker                Wrangler dev — http://127.0.0.1:8787"
	@echo "  make install               npm ci in news-feed, rss-worker, and sync-worker"

# Uses news-feed/package.json preview:gh-pages (cross-env for Windows/macOS/Linux)
preview-pages:
	cd news-feed && npm run preview:gh-pages

run: preview-pages

dev:
	npm run dev --prefix news-feed

worker:
	npm run dev --prefix rss-worker

install:
	cd news-feed && npm ci
	cd rss-worker && npm ci
	cd sync-worker && npm ci
