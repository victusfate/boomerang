/**
 * Integration test for platform-worker running locally via `wrangler dev`.
 *
 * Prerequisites:
 *   Terminal 1: make worker-platform   (or: cd platform-worker && npx wrangler dev --port 8787)
 *   Terminal 2: npm run test:integration
 *
 * Each test run uses a unique runId so results are isolated from prior DO state.
 */

const BASE_URL = 'http://localhost:8787';

// ── Synthetic data ─────────────────────────────────────────────────────────────

const runId = Date.now().toString(36);
const aliceId = `alice-${runId}`;
const bobId   = `bob-${runId}`;

// 10 synthetic article IDs (16 hex chars each)
const ARTICLES = {
  tech1:     'a1b2c3d4e5f60001',
  tech2:     'a1b2c3d4e5f60002',
  tech3:     'a1b2c3d4e5f60003',
  business1: 'b1b2c3d4e5f60004',
  business2: 'b1b2c3d4e5f60005',
  science1:  'c1b2c3d4e5f60006',
  science2:  'c1b2c3d4e5f60007',
  world1:    'd1b2c3d4e5f60008',
  extra1:    'e1b2c3d4e5f60009',
  extra2:    'e1b2c3d4e5f6000a',
};

const ALL_IDS = Object.values(ARTICLES);

const now = Date.now();

/** Alice: upvotes 3 tech, downvotes 2 business, reads 1 science */
const aliceEvents = [
  { userId: aliceId, articleId: ARTICLES.tech1,     sourceId: 'test-source', topics: ['technology'], action: 'upvote',   ts: now - 6000 },
  { userId: aliceId, articleId: ARTICLES.tech2,     sourceId: 'test-source', topics: ['technology'], action: 'upvote',   ts: now - 5000 },
  { userId: aliceId, articleId: ARTICLES.tech3,     sourceId: 'test-source', topics: ['technology'], action: 'upvote',   ts: now - 4000 },
  { userId: aliceId, articleId: ARTICLES.business1, sourceId: 'test-source', topics: ['business'],   action: 'downvote', ts: now - 3000 },
  { userId: aliceId, articleId: ARTICLES.business2, sourceId: 'test-source', topics: ['business'],   action: 'downvote', ts: now - 2000 },
  { userId: aliceId, articleId: ARTICLES.science1,  sourceId: 'test-source', topics: ['science'],    action: 'read',     ts: now - 1000 },
];

/** Bob: upvotes 2 science, reads 1 world */
const bobEvents = [
  { userId: bobId, articleId: ARTICLES.science1, sourceId: 'test-source', topics: ['science'], action: 'upvote', ts: now - 3000 },
  { userId: bobId, articleId: ARTICLES.science2, sourceId: 'test-source', topics: ['science'], action: 'upvote', ts: now - 2000 },
  { userId: bobId, articleId: ARTICLES.world1,   sourceId: 'test-source', topics: ['world'],   action: 'read',   ts: now - 1000 },
];

// ── Test harness ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function pass(n, label, ms) {
  passed++;
  console.log(`  ✓ [${n}] ${label} (${ms}ms)`);
}

function fail(n, label, ms, detail) {
  failed++;
  console.log(`  ✗ [${n}] ${label} (${ms}ms)`);
  if (detail) console.log(`      ${detail}`);
}

async function request(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, opts);
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

async function run(n, label, fn) {
  const t0 = Date.now();
  try {
    const { ok, detail } = await fn();
    const ms = Date.now() - t0;
    if (ok) pass(n, label, ms);
    else     fail(n, label, ms, detail);
  } catch (err) {
    const ms = Date.now() - t0;
    fail(n, label, ms, `threw: ${err.message}`);
  }
}

function assert(condition, detail) {
  return { ok: !!condition, detail };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

console.log(`\nPlatform-worker integration tests  (runId: ${runId})\n`);
console.log(`  alice → ${aliceId}`);
console.log(`  bob   → ${bobId}`);
console.log(`  base  → ${BASE_URL}\n`);

// 1. Health check
await run(1, 'GET /health → 200 { ok: true }', async () => {
  const { status, json } = await request('GET', '/health');
  if (status !== 200) return assert(false, `status ${status}, expected 200`);
  if (!json?.ok)      return assert(false, `body.ok is ${json?.ok}, expected true`);
  return assert(true);
});

// 2. POST /interactions — alice (6 events)
await run(2, 'POST /interactions (alice, 6 events) → queued >= 6', async () => {
  const { status, json } = await request('POST', '/interactions', aliceEvents);
  if (status !== 200) return assert(false, `status ${status}, body: ${JSON.stringify(json)}`);
  const queued = json?.queued ?? json?.accepted ?? json?.count ?? 0;
  if (queued < 6) return assert(false, `queued=${queued}, expected >= 6; body: ${JSON.stringify(json)}`);
  return assert(true);
});

// 3. POST /interactions — bob (3 events)
await run(3, 'POST /interactions (bob, 3 events) → queued >= 3', async () => {
  const { status, json } = await request('POST', '/interactions', bobEvents);
  if (status !== 200) return assert(false, `status ${status}, body: ${JSON.stringify(json)}`);
  const queued = json?.queued ?? json?.accepted ?? json?.count ?? 0;
  if (queued < 3) return assert(false, `queued=${queued}, expected >= 3; body: ${JSON.stringify(json)}`);
  return assert(true);
});

// 4. POST /recommendations/alice — feed-pool with all 10 candidates
await run(4, `POST /recommendations/${aliceId} → 200, candidateCount=10, downvotes excluded`, async () => {
  const { status, json } = await request('POST', `/recommendations/${aliceId}`, {
    candidateArticleIds: ALL_IDS,
    limit: 10,
  });
  if (status !== 200) return assert(false, `status ${status}, body: ${JSON.stringify(json)}`);

  const articleIds = json?.articleIds;
  if (!Array.isArray(articleIds)) return assert(false, `articleIds missing or not an array; body: ${JSON.stringify(json)}`);

  const candidateCount = json?.diagnostics?.candidateCount;
  if (candidateCount !== 10) return assert(false, `diagnostics.candidateCount=${candidateCount}, expected 10`);

  // Key correctness: downvoted business articles must not appear in results
  const downvoted = [ARTICLES.business1, ARTICLES.business2];
  const leaked = downvoted.filter(id => articleIds.includes(id));
  if (leaked.length > 0) return assert(false, `downvoted articles appeared in results: ${leaked.join(', ')}`);

  // Tech upvotes should rank ahead of any non-excluded articles
  const upvoted = [ARTICLES.tech1, ARTICLES.tech2, ARTICLES.tech3];
  const upvotedInResults = upvoted.filter(id => articleIds.includes(id));
  // At minimum, upvoted articles should appear if candidateCount > 0
  if (articleIds.length > 0 && upvotedInResults.length === 0) {
    return assert(false, `none of alice's upvoted tech articles appeared in results: ${articleIds.join(', ')}`);
  }

  return assert(true);
});

// 5. GET /recommendations/bob — global recs
await run(5, `GET /recommendations/${bobId} → 200, valid RecResponse shape`, async () => {
  const { status, json } = await request('GET', `/recommendations/${bobId}`);
  if (status !== 200) return assert(false, `status ${status}, body: ${JSON.stringify(json)}`);
  if (!Array.isArray(json?.articleIds)) return assert(false, `articleIds missing; body: ${JSON.stringify(json)}`);
  if (!Array.isArray(json?.scoredArticleIds)) return assert(false, `scoredArticleIds missing; body: ${JSON.stringify(json)}`);
  if (typeof json?.diagnostics !== 'object' || json.diagnostics === null) {
    return assert(false, `diagnostics missing; body: ${JSON.stringify(json)}`);
  }
  return assert(true);
});

// 6. GET /rec/debug — model state diagnostics
await run(6, 'GET /rec/debug → 200, has model state fields', async () => {
  const { status, json } = await request('GET', '/rec/debug');
  if (status !== 200) return assert(false, `status ${status}, body: ${JSON.stringify(json)}`);
  // Accept any reasonable shape: globalState object or individual factor counts
  const hasGlobalState   = typeof json?.globalState === 'object';
  const hasFactorCounts  = typeof json?.userFactorsCount === 'number'
                        || typeof json?.itemFactorsCount  === 'number'
                        || typeof json?.interactionsCount === 'number';
  if (!hasGlobalState && !hasFactorCounts) {
    return assert(false, `expected globalState or factor-count fields; body: ${JSON.stringify(json)}`);
  }
  return assert(true);
});

// 7. GET /rec/articles?ids=... — article metadata lookup
await run(7, 'GET /rec/articles?ids=... → 200, has ok field', async () => {
  const ids = [ARTICLES.tech1, ARTICLES.tech2].join(',');
  const { status, json } = await request('GET', `/rec/articles?ids=${ids}`);
  if (status !== 200) return assert(false, `status ${status}, body: ${JSON.stringify(json)}`);
  if (!('ok' in (json ?? {}))) return assert(false, `response missing 'ok' field; body: ${JSON.stringify(json)}`);
  return assert(true);
});

// ── Error / edge cases ─────────────────────────────────────────────────────────

// 8. POST /interactions with invalid body → 400
await run(8, 'POST /interactions with invalid body → 400', async () => {
  const { status } = await request('POST', '/interactions', { not: 'valid' });
  if (status !== 400) return assert(false, `status ${status}, expected 400`);
  return assert(true);
});

// 9. POST /recommendations with too many candidates (> 100) → 400
await run(9, 'POST /recommendations with 101 candidates → 400', async () => {
  // Generate 101 fake IDs
  const tooMany = Array.from({ length: 101 }, (_, i) =>
    i.toString(16).padStart(16, 'f')
  );
  const { status } = await request('POST', `/recommendations/${aliceId}`, {
    candidateArticleIds: tooMany,
  });
  if (status !== 400) return assert(false, `status ${status}, expected 400`);
  return assert(true);
});

// ── Summary ────────────────────────────────────────────────────────────────────

const total = passed + failed;
console.log(`\n${'─'.repeat(56)}`);
console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} FAILED` : ''}`);
console.log(`${'─'.repeat(56)}\n`);

if (failed > 0) process.exit(1);
