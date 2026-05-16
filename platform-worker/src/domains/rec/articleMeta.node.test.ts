import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  articleMetaCacheKey,
  normalizeArticleMeta,
  normalizeIdsParam,
  wireArticleFromFeed,
  ARTICLE_META_TTL_SECONDS,
  MAX_ARTICLE_IDS_LOOKUP,
} from './articleMetaContract.ts';
import {
  articleRecordKey,
  catalogFromArticleRecord,
  ARTICLE_RECORD_TTL_SECONDS,
} from '../meta/articleRecord.ts';
import {
  loadCachedArticleMeta,
  persistArticleMeta,
  getKvCounters,
  resetMemCacheForTest,
  resetKvCountersForTest,
} from './articleMetaKv.ts';

// ── Mock KV namespace ─────────────────────────────────────────────────────
// Simulates Cloudflare KV: get(key, 'json') returns parsed object; put() stores parsed JSON.
function makeKv(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    get: async (key: string, _type?: string) => store.get(key) ?? null,
    put: async (key: string, value: string, _opts?: unknown) => { store.set(key, JSON.parse(value)); },
  };
}

function makeEnv(articleMeta: ReturnType<typeof makeKv>, recStore?: ReturnType<typeof makeKv>) {
  return {
    ARTICLE_META: articleMeta,
    REC_STORE: recStore ?? makeKv(),
  } as unknown as import('../../env').Env;
}

const SAMPLE_META = {
  id: 'a1',
  title: 'Test Article',
  source: 'Test Source',
  sourceId: 'test-src',
  publishedAt: '2026-01-01',
  url: 'https://example.com/a1',
} as const;

const SAMPLE_RECORD = {
  articleId: 'a1',
  tags: ['ai'],
  updatedAt: 1000,
  title: 'Test Article',
  source: 'Test Source',
  sourceId: 'test-src',
  publishedAt: '2026-01-01',
  url: 'https://example.com/a1',
};

describe('articleMeta catalog contract', () => {
  it('uses meta: KV key with shared catalog TTL', () => {
    assert.equal(articleRecordKey('abc'), 'meta:abc');
    assert.equal(ARTICLE_RECORD_TTL_SECONDS, ARTICLE_META_TTL_SECONDS);
    assert.equal(ARTICLE_RECORD_TTL_SECONDS, 180 * 24 * 60 * 60);
  });

  it('reads catalog fields from unified article record', () => {
    const catalog = catalogFromArticleRecord({
      articleId: 'a1',
      tags: ['ai'],
      updatedAt: 1,
      title: 'Hello',
      source: 'Src',
      sourceId: 'src-1',
      publishedAt: '2026-01-01',
      url: 'https://example.com/a1',
    });
    assert.deepEqual(catalog, {
      id: 'a1',
      title: 'Hello',
      source: 'Src',
      sourceId: 'src-1',
      publishedAt: '2026-01-01',
      url: 'https://example.com/a1',
    });
  });

  it('legacy rec:article-meta key still parseable', () => {
    assert.equal(articleMetaCacheKey('abc'), 'rec:article-meta:abc');
  });

  it('dedupes and caps ids', () => {
    const many = Array.from({ length: MAX_ARTICLE_IDS_LOOKUP + 10 }, (_, i) => `id-${i}`);
    const ids = normalizeIdsParam([...many, 'dup', 'dup'].join(','));
    assert.equal(ids.length, MAX_ARTICLE_IDS_LOOKUP);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('normalizes valid article metadata', () => {
    const meta = normalizeArticleMeta({
      id: 'a1',
      title: 'Hello',
      source: 'Src',
      sourceId: 'src-1',
      publishedAt: '2026-01-01',
      url: 'https://example.com/a1',
    });
    assert.deepEqual(meta, wireArticleFromFeed({
      id: 'a1',
      title: 'Hello',
      source: 'Src',
      sourceId: 'src-1',
      publishedAt: '2026-01-01',
      url: 'https://example.com/a1',
    }));
  });

  it('rejects incomplete metadata', () => {
    assert.equal(normalizeArticleMeta({ id: 'x' }), null);
  });
});

describe('articleMeta memory cache — loadCachedArticleMeta', () => {
  beforeEach(() => {
    resetMemCacheForTest();
    resetKvCountersForTest();
  });

  it('reads from KV on first call and warms mem cache', async () => {
    const env = makeEnv(makeKv({ 'meta:a1': SAMPLE_RECORD }));
    const result = await loadCachedArticleMeta(env, ['a1']);

    assert.equal(result.size, 1);
    assert.equal(result.get('a1')?.title, 'Test Article');
    assert.equal(getKvCounters().reads, 1);
    assert.equal(getKvCounters().memHits, 0);
  });

  it('serves from mem cache on second call without KV read', async () => {
    const env = makeEnv(makeKv({ 'meta:a1': SAMPLE_RECORD }));
    await loadCachedArticleMeta(env, ['a1']); // warm cache
    resetKvCountersForTest();

    const result = await loadCachedArticleMeta(env, ['a1']);
    assert.equal(result.size, 1);
    assert.equal(getKvCounters().reads, 0);
    assert.equal(getKvCounters().memHits, 1);
  });

  it('falls back to legacy REC_STORE and warms cache on primary KV miss', async () => {
    const legacyMeta = { ...SAMPLE_META };
    const env = makeEnv(makeKv(), makeKv({ 'rec:article-meta:a1': legacyMeta }));
    const result = await loadCachedArticleMeta(env, ['a1']);

    assert.equal(result.size, 1);
    assert.equal(getKvCounters().reads, 2); // primary miss + legacy hit
    assert.equal(getKvCounters().memHits, 0);

    // Second call uses mem cache
    resetKvCountersForTest();
    await loadCachedArticleMeta(env, ['a1']);
    assert.equal(getKvCounters().reads, 0);
    assert.equal(getKvCounters().memHits, 1);
  });

  it('returns empty map and does not increment reads for empty id list', async () => {
    const env = makeEnv(makeKv());
    const result = await loadCachedArticleMeta(env, []);
    assert.equal(result.size, 0);
    assert.equal(getKvCounters().reads, 0);
    assert.equal(getKvCounters().memHits, 0);
  });
});

describe('articleMeta memory cache — persistArticleMeta', () => {
  beforeEach(() => {
    resetMemCacheForTest();
    resetKvCountersForTest();
  });

  it('writes to KV and warms mem cache for new article', async () => {
    const kv = makeKv();
    const env = makeEnv(kv);
    await persistArticleMeta(env, [SAMPLE_META]);

    assert.equal(getKvCounters().reads, 1);
    assert.equal(getKvCounters().writes, 1);
    assert.equal(getKvCounters().memHits, 0);
  });

  it('skips KV read+write on second call with identical fields (mem cache hit)', async () => {
    const env = makeEnv(makeKv());
    await persistArticleMeta(env, [SAMPLE_META]); // warm cache
    resetKvCountersForTest();

    await persistArticleMeta(env, [SAMPLE_META]);
    assert.equal(getKvCounters().reads, 0);
    assert.equal(getKvCounters().writes, 0);
    assert.equal(getKvCounters().memHits, 1);
  });

  it('reads KV but skips write when KV record already matches (cold isolate path)', async () => {
    // Pre-populate KV as-if another isolate wrote it; mem cache is empty
    const kv = makeKv({ 'meta:a1': SAMPLE_RECORD });
    const env = makeEnv(kv);

    await persistArticleMeta(env, [SAMPLE_META]);
    assert.equal(getKvCounters().reads, 1);
    assert.equal(getKvCounters().writes, 0); // write guard skips redundant write
    assert.equal(getKvCounters().memHits, 0);

    // Warms cache — second call is mem cache hit
    resetKvCountersForTest();
    await persistArticleMeta(env, [SAMPLE_META]);
    assert.equal(getKvCounters().reads, 0);
    assert.equal(getKvCounters().memHits, 1);
  });

  it('writes to KV when title changes and updates mem cache', async () => {
    const env = makeEnv(makeKv());
    await persistArticleMeta(env, [SAMPLE_META]); // warm cache with original title
    resetKvCountersForTest();

    const updated = { ...SAMPLE_META, title: 'Updated Title' };
    await persistArticleMeta(env, [updated]);
    assert.equal(getKvCounters().reads, 1);  // mem cache mismatch → KV read
    assert.equal(getKvCounters().writes, 1); // field changed → write
    assert.equal(getKvCounters().memHits, 0);

    // Mem cache now has updated title — next persist with same updated meta skips KV
    resetKvCountersForTest();
    await persistArticleMeta(env, [updated]);
    assert.equal(getKvCounters().reads, 0);
    assert.equal(getKvCounters().memHits, 1);
  });

  it('handles empty entries without any KV operations', async () => {
    const env = makeEnv(makeKv());
    await persistArticleMeta(env, []);
    assert.equal(getKvCounters().reads, 0);
    assert.equal(getKvCounters().writes, 0);
  });
});

describe('articleMeta KV counters', () => {
  it('getKvCounters returns a snapshot (not a live reference)', () => {
    resetKvCountersForTest();
    const snap1 = getKvCounters();
    // Mutating the snapshot does not affect internal state
    (snap1 as { reads: number }).reads = 999;
    const snap2 = getKvCounters();
    assert.equal(snap2.reads, 0);
  });
});
