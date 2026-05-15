import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { REC_MAX_CANDIDATES } from '@victusfate/ricochet';
import {
  chunkArticleIds,
  dedupeArticleIds,
  mergeFeedPoolRecResponses,
  type RecResponseWithScores,
} from './recPoolMerge.ts';

function part(
  scores: Array<[string, number]>,
  overrides: Partial<RecResponseWithScores['diagnostics']> = {},
): RecResponseWithScores {
  const scoredArticleIds = scores.map(([articleId, score]) => ({ articleId, score }));
  const articleIds = scoredArticleIds.map(r => r.articleId);
  return {
    articleIds,
    generatedAt: 1,
    scoredArticleIds,
    diagnostics: {
      model: 'biased-mf',
      modelVersion: 'v1',
      factorCount: 10,
      candidateMode: 'feed-pool',
      candidateCount: articleIds.length,
      rankedCount: articleIds.length,
      returnedCount: articleIds.length,
      excludedDownvotes: 0,
      coldStart: false,
      limit: articleIds.length,
      ...overrides,
    },
    trace: { requestId: 't' },
    cache: { status: 'miss', key: 'k', ttlSec: 300, ageSec: 0 },
    timingMs: { total: 1, cacheLookup: 0, doFetch: 1, cacheWrite: 0 },
    scoreById: Object.fromEntries(scores),
  };
}

describe('dedupeArticleIds', () => {
  it('preserves first occurrence order', () => {
    assert.deepEqual(dedupeArticleIds(['b', 'a', 'b', '']), ['b', 'a']);
  });
});

describe('chunkArticleIds', () => {
  it(`splits into chunks of ${REC_MAX_CANDIDATES}`, () => {
    const ids = Array.from({ length: 250 }, (_, i) => `id${i}`);
    const chunks = chunkArticleIds(ids);
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0].length, REC_MAX_CANDIDATES);
    assert.equal(chunks[1].length, REC_MAX_CANDIDATES);
    assert.equal(chunks[2].length, 50);
  });
});

describe('mergeFeedPoolRecResponses', () => {
  it('orders globally by highest MF score across batches', () => {
    const merged = mergeFeedPoolRecResponses(
      [
        part([['a', 1.0], ['b', 0.5]]),
        part([['c', 1.5], ['d', 0.2]]),
      ],
      4,
    );
    assert.deepEqual(merged.articleIds, ['c', 'a', 'b', 'd']);
    assert.equal(merged.diagnostics.candidateMode, 'feed-pool');
    assert.equal(merged.diagnostics.candidateCount, 4);
  });

  it('keeps best score when the same id appears in two batches', () => {
    const merged = mergeFeedPoolRecResponses(
      [part([['x', 0.3]]), part([['x', 0.9]])],
      1,
    );
    assert.deepEqual(merged.articleIds, ['x']);
    assert.equal(merged.scoreById.x, 0.9);
  });
});
