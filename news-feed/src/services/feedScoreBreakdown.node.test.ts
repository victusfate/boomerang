import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Article } from '../types';
import { buildRecRankMap, computeFeedScoreInsight, countSourceArticles } from './feedScoreBreakdown.ts';

function article(id: string, sourceId = 'hn'): Article {
  return {
    id,
    title: `Title ${id}`,
    url: `https://example.com/${id}`,
    description: '',
    publishedAt: new Date(),
    source: 'HN',
    sourceId,
    topics: ['technology'],
    fetchTier: 'fast',
  };
}

describe('feedScoreBreakdown', () => {
  it('buildRecRankMap normalises ends', () => {
    const m = buildRecRankMap(['a', 'b', 'c']);
    assert.equal(m.get('a'), 0);
    assert.equal(m.get('c'), 1);
  });

  it('computeFeedScoreInsight includes mf and boost', () => {
    const pool = [article('a'), article('b', 'ars')];
    const counts = countSourceArticles(pool);
    const recIds = ['b', 'a'];
    const insight = computeFeedScoreInsight(
      pool[0],
      counts,
      buildRecRankMap(recIds),
      { a: 0.42 },
      recIds,
    );
    assert.equal(insight.mfScore, 0.42);
    assert.equal(insight.recListRank, 2);
    assert.ok(insight.recBoost < 1.8);
    assert.ok(insight.composite > 0);
  });
});
