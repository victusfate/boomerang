/**
 * Bookmarklet integration smoke test (headless Chromium).
 *
 * Exercises the whole capture flow the way a real browser does, spanning both
 * packages:
 *   1. `buildBookmarklet` (news-feed) produces the `javascript:` snippet.
 *   2. A page runs that snippet — it must NAVIGATE via `location.href`, not open
 *      a popup (iOS Safari / Android Chrome block popups from bookmarklets; that
 *      was the mobile bug this branch fixes).
 *   3. The worker's `/save` page (platform-worker `handleCapture`) renders the
 *      redesigned confirmation card and the capture is persisted to the room.
 *
 * Requires Playwright + a Chromium build (pre-installed locally at
 * $PLAYWRIGHT_BROWSERS_PATH; `npx playwright install chromium` in CI).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser } from 'playwright';
import { buildBookmarklet } from '../src/services/captureWorker.ts';
import { handleCapture } from '../../platform-worker/src/domains/capture/index.ts';
import { generateCaptureToken } from '../../platform-worker/src/domains/capture/token.ts';

const WORKER = 'https://api.boomerang-news.test';
const ARTICLE = 'https://news.example.test/story/mobile-capture-works';
const ARTICLE_TITLE = 'Why Bookmarklets Need Real Navigation on Mobile';
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const NAV_TIMEOUT_MS = 5_000;

// ── Mock worker env (mirrors platform-worker/src/domains/capture/index.node.test.ts) ──
function makeKv(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    get: async (k: string, type?: string) => {
      const r = store.get(k);
      if (r === undefined) return null;
      return type === 'json' ? JSON.parse(r) : r;
    },
    put: async (k: string, v: string) => { store.set(k, v); },
    delete: async (k: string) => { store.delete(k); },
  };
}
function makeR2() {
  const store = new Map<string, { body: string; etag: string }>();
  return {
    store,
    get: async (k: string) => {
      const o = store.get(k);
      if (!o) return null;
      return { text: async () => o.body, etag: o.etag };
    },
    put: async (k: string, body: string) => { store.set(k, { body, etag: 'e1' }); return { etag: 'e1' }; },
  };
}
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };

describe('bookmarklet capture flow (headless Chromium)', () => {
  let browser: Browser;

  before(async () => { browser = await chromium.launch({ headless: true }); });
  after(async () => { await browser?.close(); });

  it('navigates via location.href (no popup) and renders the save card', async () => {
    const kv = makeKv();
    const r2 = makeR2();
    const { captureToken } = await generateCaptureToken(kv as never, 'roomVERIFY', { type: 'saved-list' });
    const env = { CAPTURE_TOKENS: kv, SYNC_BLOCKS: r2 } as never;

    const bookmarklet = buildBookmarklet(WORKER, captureToken);
    assert.ok(bookmarklet.includes('location.href=u'), 'must navigate, not popup');
    assert.ok(!bookmarklet.includes('window.open'), 'window.open is blocked on mobile');

    const context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
    const page = await context.newPage();

    let popupOpened = false;
    context.on('page', () => { popupOpened = true; });
    page.on('popup', () => { popupOpened = true; });

    // Serve the fake article page…
    await page.route(ARTICLE, route =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><title>${ARTICLE_TITLE}</title><h1>${ARTICLE_TITLE}</h1><p>selectable body</p>`,
      }),
    );
    // …and the REAL worker save page by running handleCapture on the intercepted request.
    let saveHits = 0;
    await page.route('**/save/**', async (route) => {
      saveHits++;
      const res = await handleCapture(new Request(route.request().url(), { method: 'GET' }), env, ctx as never);
      await route.fulfill({ status: res.status, contentType: 'text/html; charset=utf-8', body: await res.text() });
    });

    await page.goto(ARTICLE, { waitUntil: 'domcontentloaded' });
    await page.evaluate(t => { document.title = t; }, ARTICLE_TITLE);

    // Fire the bookmarklet exactly as a browser would: strip `javascript:`, eval the body.
    await Promise.allSettled([
      page.waitForURL('**/save/**', { timeout: NAV_TIMEOUT_MS }),
      page.evaluate(code => { eval(code.replace(/^javascript:/, '')); }, bookmarklet).catch(() => {}),
    ]);

    const landed = page.url();
    assert.ok(landed.includes('/save/'), 'bookmarklet navigated to the save page');
    assert.equal(popupOpened, false, 'no popup window opened (mobile-safe)');
    assert.equal(saveHits, 1, 'save endpoint hit exactly once');
    assert.ok(landed.includes(encodeURIComponent(ARTICLE)), 'save url carries the page url');
    assert.ok(landed.includes(encodeURIComponent(ARTICLE_TITLE)), 'save url carries the page title');

    // The redesigned confirmation card.
    assert.equal((await page.textContent('h1'))?.trim(), 'Saved!');
    assert.equal((await page.textContent('.brand'))?.trim(), 'Boomerang');
    assert.ok((await page.textContent('.mt'))?.includes('Bookmarklets Need Real Navigation'));
    assert.equal((await page.textContent('.md'))?.trim(), 'news.example.test');
    assert.equal(await page.locator('button', { hasText: 'Go back' }).count(), 1);

    // The capture was actually persisted to the room's saved list.
    const meta = JSON.parse(r2.store.get('roomVERIFY/meta')?.body ?? '{}');
    assert.equal(meta.savedArticles?.[0]?.url, ARTICLE, 'article persisted to saved list');

    await context.close();
  });
});
