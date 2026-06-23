/**
 * Smoke test for the capture connector against a locally-running platform-worker.
 *
 * Prerequisites:
 *   Terminal 1: cd platform-worker && npx wrangler dev --port 8787
 *   Terminal 2: RUN_INTEGRATION=1 node scripts/capture-smoke-test.mjs
 *
 * Gated on RUN_INTEGRATION so it is skipped in environments without a worker.
 */

if (!process.env.RUN_INTEGRATION) {
  console.log('skip capture-smoke-test — set RUN_INTEGRATION=1 with `wrangler dev` running');
  process.exit(0);
}

const BASE_URL = process.env.CAPTURE_BASE_URL ?? 'http://localhost:8787';
const RATE_LIMIT_MAX = 60;

let passed = 0;
let failed = 0;

function pass(n, label) { passed++; console.log(`  ✓ [${n}] ${label}`); }
function fail(n, label, detail) { failed++; console.log(`  ✗ [${n}] ${label}`); if (detail) console.log(`      ${detail}`); }
function assert(condition, detail) { return { ok: !!condition, detail }; }

async function run(n, label, fn) {
  try {
    const { ok, detail } = await fn();
    if (ok) pass(n, label); else fail(n, label, detail);
  } catch (err) {
    fail(n, label, `threw: ${err.message}`);
  }
}

async function createRoom() {
  const res = await fetch(`${BASE_URL}/sync/room`, { method: 'POST' });
  if (res.status !== 201) throw new Error(`room create failed: ${res.status}`);
  return res.json();
}

async function generateToken(room, destination = { type: 'saved-list' }) {
  const res = await fetch(`${BASE_URL}/api/capture/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${room.token}` },
    body: JSON.stringify({ roomId: room.roomId, destination }),
  });
  return res;
}

async function capture(token, url) {
  return fetch(`${BASE_URL}/api/capture/${token}`, {
    method: 'POST',
    body: JSON.stringify({ url, title: 'Smoke', source: 'smoke' }),
  });
}

async function savePopup(token, url, title = 'Smoke Popup') {
  return fetch(`${BASE_URL}/save/${token}?u=${encodeURIComponent(url)}&ti=${encodeURIComponent(title)}`);
}

console.log(`\nCapture connector smoke tests  (base: ${BASE_URL})\n`);

const room = await createRoom();

// 1. Generate a capture token
let captureToken;
await run(1, 'POST /api/capture/token → 200 { captureToken }', async () => {
  const res = await generateToken(room);
  if (res.status !== 200) return assert(false, `status ${res.status}`);
  const json = await res.json();
  captureToken = json.captureToken;
  return assert(typeof captureToken === 'string' && captureToken.length > 0, `token: ${captureToken}`);
});

// 2. Capture a page
await run(2, 'POST /api/capture/:token → 204', async () => {
  const res = await capture(captureToken, 'https://example.com/smoke-1');
  return assert(res.status === 204, `status ${res.status}`);
});

// 3. Duplicate within window is silently dropped
await run(3, 'POST duplicate url → 204 (silent drop)', async () => {
  const res = await capture(captureToken, 'https://example.com/smoke-1');
  return assert(res.status === 204, `status ${res.status}`);
});

// 4. Invalid url
await run(4, 'POST invalid url → 400', async () => {
  const res = await capture(captureToken, 'ftp://example.com/x');
  return assert(res.status === 400, `status ${res.status}`);
});

// 5. Unknown token
await run(5, 'POST unknown token → 401', async () => {
  const res = await capture('definitely-not-a-real-token', 'https://example.com/x');
  return assert(res.status === 401, `status ${res.status}`);
});

// 6. Rate limit — uses a fresh token so prior captures don't skew the count
await run(6, `POST ${RATE_LIMIT_MAX + 1} captures → 429 on the last`, async () => {
  const rlRoom = await createRoom();
  const res = await generateToken(rlRoom);
  const { captureToken: rlToken } = await res.json();
  let last;
  for (let i = 0; i <= RATE_LIMIT_MAX; i++) {
    last = await capture(rlToken, `https://example.com/rl-${i}`);
  }
  return assert(last.status === 429, `final status ${last.status}, expected 429`);
});

// 7. Bookmarklet popup: GET /save/:token → 200 HTML that auto-closes
await run(7, 'GET /save/:token → 200 auto-closing HTML', async () => {
  const res = await savePopup(captureToken, 'https://example.com/popup-smoke');
  if (res.status !== 200) return assert(false, `status ${res.status}`);
  const ct = res.headers.get('content-type') ?? '';
  const html = await res.text();
  return assert(
    ct.includes('text/html') && html.includes('window.close') && html.includes('Saved to boomerang'),
    `ct=${ct} hasClose=${html.includes('window.close')}`,
  );
});

// 8. Revoke → subsequent capture is unauthorized
await run(8, 'DELETE /api/capture/token → 204, then capture → 401', async () => {
  const del = await fetch(`${BASE_URL}/api/capture/token`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${room.token}` },
    body: JSON.stringify({ roomId: room.roomId }),
  });
  if (del.status !== 204) return assert(false, `revoke status ${del.status}`);
  const res = await capture(captureToken, 'https://example.com/after-revoke');
  return assert(res.status === 401, `post-revoke status ${res.status}, expected 401`);
});

console.log(`\nResults: ${passed}/${passed + failed} passed\n`);
process.exit(failed === 0 ? 0 : 1);
