# Custom domain for the platform worker — `api.boomerang-news.com`

How the platform worker got a first-party subdomain in one deploy, and how to
point the frontend at it. Preferred over the `*.workers.dev` default URL.

## Why bother

- The `*.workers.dev` default host is heavily on ad/tracker **filter lists**
  (Brave Shields, uBlock). That silently blocks the capture bookmarklet's calls
  and makes the API look third-party to the browser.
- A first-party subdomain on your own zone dodges those filters and reads as
  same-site to `boomerang-news.com`.

## Why it was fast

The apex domain `boomerang-news.com` is already a **Cloudflare zone on the same
account** as the worker. When that's true, `wrangler deploy` provisions the
whole custom domain — proxied DNS record, TLS cert, and worker route — in one
step. No dashboard clicks, no manual DNS, no cert wait.

Check the prerequisite:

```bash
dig +short NS boomerang-news.com   # → *.ns.cloudflare.com  (zone is on Cloudflare)
```

## Steps

1. Add a custom-domain route in `platform-worker/wrangler.jsonc`:

   ```jsonc
   // Keep the *.workers.dev URL alive too — see the gotcha below.
   "workers_dev": true,
   "routes": [
     { "pattern": "api.boomerang-news.com", "custom_domain": true }
   ],
   ```

2. Deploy:

   ```bash
   cd platform-worker && npx wrangler deploy
   ```

   Wrangler creates the proxied `api` DNS record pointing at the worker, issues
   the TLS cert, and binds the route. Live within ~a minute. The deploy output
   lists both routes (`…workers.dev` and `api.boomerang-news.com (custom domain)`).

3. Verify:

   ```bash
   curl -s https://api.boomerang-news.com/health        # → {"ok":true,...}
   ```

No CORS config change was needed: requests come from the `boomerang-news.com`
origin, which is already in the worker's allowlist
(`BOOMERANG_PRODUCTION_CORS_ORIGINS` in `platform-worker/src/corsOrigins.ts`).

## Gotcha — `routes` disables `workers.dev`

Defining **any** `routes`/`custom_domain` turns **off** the `*.workers.dev`
subdomain unless you also set `"workers_dev": true`. Learned the hard way: the
first deploy (without `workers_dev`) 404'd the old URL at the edge (Cloudflare
error 1042) and broke the still-deployed frontend that still targeted it — a
production CORS/fetch regression. Keep `workers_dev: true` until every consumer
has moved off the workers.dev URL.

## Point the frontend at it

The frontend bakes `VITE_PLATFORM_WORKER_URL` in at build time
(`news-feed/src/config/workerEnv.ts`). Set it to the subdomain **with scheme, no
trailing slash**: `https://api.boomerang-news.com`.

| Build path | Where to set it |
|---|---|
| Cloudflare Workers Builds (serves `boomerang-news.com`) | the build's **Environment variables** (CF dashboard) |
| GitHub Actions / Pages mirror (`deploy.yml`) | repo **Variable** `VITE_PLATFORM_WORKER_URL` |
| Local dev | `news-feed/.env` |

`index.html` warms the connection via `%VITE_PLATFORM_WORKER_URL%` (Vite HTML env
substitution), so the preconnect tracks the same value automatically — a good
post-deploy sanity check: view-source on the live page and confirm the
`<link rel="preconnect">` points at `api.boomerang-news.com`.

## Retiring `workers.dev` later

Once nothing references the old URL (frontend builds, the `victusfate.github.io`
Pages mirror, ricochet integrators), drop `workers_dev: true` and redeploy to
disable the subdomain.
