#!/usr/bin/env bash
#
# Provision the CAPTURE_TOKENS KV namespace for the capture connector.
#
# This namespace backs capture tokens, the reverse index, and the rate-limit +
# dedupe keys. `wrangler dev --local` uses in-memory KV and ignores it, so this
# is only needed before a production `wrangler deploy`.
#
# Usage:
#   cd platform-worker && ./scripts/provision-capture-kv.sh
#
# After it prints the namespace id, paste that id into the CAPTURE_TOKENS
# binding in wrangler.jsonc (replacing any existing id), then:
#   npx wrangler deploy
#
# Custom domain (api.boomerang-news.com): the `routes` entry in wrangler.jsonc
# provisions it on `wrangler deploy` — no separate command. It requires the
# boomerang-news.com zone on this Cloudflare account. The bookmarklet's /save
# popup and the app both target this first-party host to dodge ad/tracker
# filter lists that block workers.dev. After deploy, point the frontend at it:
#   VITE_PLATFORM_WORKER_URL=https://api.boomerang-news.com   (GitHub Actions repo var)
#
# Already provisioned (2026-06-23): 6fe3297cd67940838715c3a3bc9b905d

set -euo pipefail

cd "$(dirname "$0")/.."

echo "Creating KV namespace CAPTURE_TOKENS…"
npx wrangler kv namespace create CAPTURE_TOKENS

echo
echo "Copy the id above into the CAPTURE_TOKENS binding in wrangler.jsonc,"
echo "then run: npx wrangler deploy"
