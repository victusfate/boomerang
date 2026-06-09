# Testing

## Unit tests

```bash
make test
```

Runs Node's built-in test runner with `--experimental-strip-types` across all pure-function test files in `news-feed/` and `platform-worker/`. No browser or worker required.

---

## Headless UI tests (Playwright)

`news-feed/ui-test.mjs` exercises the live app in a headless Chromium browser. It requires both the platform worker and the Vite preview server to be running first.

### Local

```bash
# 1. Install dependencies (once)
make install

# 2. Copy env (once)
cp news-feed/.env.example news-feed/.env   # sets VITE_PLATFORM_WORKER_URL=http://localhost:8787

# 3. Start the worker (terminal 1)
make worker-platform

# 4. Build and start the frontend preview (terminal 2)
cd news-feed && npx vite build && npx vite preview --port 4173

# 5. Run the UI tests (terminal 3)
cd news-feed && node ui-test.mjs
```

### Cloud / headless CI environment

In a cloud agent session (e.g. Claude Code on the web) where `node_modules` may not be pre-installed:

```bash
# Install deps
cd /path/to/boomerang/news-feed && npm ci
cd /path/to/boomerang/platform-worker && npm ci

# Start the worker in the background
cd /path/to/boomerang/platform-worker && npx wrangler dev --port 8787 &
sleep 4   # wait for miniflare to start

# Build the frontend (picks up VITE_PLATFORM_WORKER_URL from .env)
cd /path/to/boomerang/news-feed && npx vite build

# Start the preview server in the background
npx vite preview --port 4173 &
sleep 2

# Run the UI tests
node ui-test.mjs
```

### Playwright availability

Playwright is expected to be available globally at `/opt/node22/lib/node_modules/playwright` with Chromium at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`. If those paths differ in your environment, update the import and `executablePath` at the top of `ui-test.mjs`.

To install Playwright locally instead:

```bash
cd news-feed && npm install --save-dev playwright
npx playwright install chromium
```

Then change the import in `ui-test.mjs` from the absolute path to `'playwright'`.

---

## What the UI tests cover

| Check | Notes |
|---|---|
| Tab labels (Feed, Queue) | Verifies rename from "Saved" → "Queue" |
| "Saved" label gone | Regression guard |
| Clear-all button hidden when queue is empty | Conditional render |
| Done state or error state shown | Done state requires successful feed load; falls back to asserting error state in no-backend envs |
| Feed tab navigation | Tab switching still works |
