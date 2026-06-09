# Testing

## Unit tests

```bash
make test
```

Runs Node's built-in test runner with `--experimental-strip-types` across all pure-function test files in `news-feed/` and `platform-worker/`. No browser or worker required.

---

## Headless UI tests (Playwright)

`news-feed/ui-test.mjs` exercises the live app in a headless Chromium browser. It requires both the platform worker and the Vite dev server to be running.

### Setup (once)

```bash
make install                               # npm ci in all packages
cp news-feed/.env.example news-feed/.env   # sets VITE_PLATFORM_WORKER_URL=http://localhost:8787
```

### Run

```bash
# Terminal 1
make worker-platform   # wrangler dev → http://localhost:8787

# Terminal 2
make dev               # Vite dev server → http://localhost:5173

# Terminal 3
cd news-feed && node ui-test.mjs
```

### Cloud / headless agent environment

Same steps, but run the worker and dev server in the background:

```bash
make install
cp news-feed/.env.example news-feed/.env

make worker-platform &   # background; wait ~4s for miniflare to start
sleep 4
make dev &               # background; wait ~2s for Vite to start
sleep 2

cd news-feed && node ui-test.mjs
```

### Playwright availability

`ui-test.mjs` imports Playwright from its global install path (`/opt/node22/lib/node_modules/playwright`) and uses the pre-installed Chromium at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`. If those paths differ, update the import and `executablePath` at the top of the file.

To use a project-local install instead:

```bash
cd news-feed && npm install --save-dev playwright && npx playwright install chromium
```

Then change the import in `ui-test.mjs` to `'playwright'` and remove the `executablePath` override.

---

## What the UI tests cover

| Check | Notes |
|---|---|
| Tab labels (Feed, Queue) | Verifies rename from "Saved" → "Queue" |
| "Saved" label gone | Regression guard |
| Clear-all button hidden when queue is empty | Conditional render |
| Done state or error state shown | Done state requires successful feed load; falls back to asserting error state when backend is unreachable |
| Feed tab navigation | Tab switching still works |
