import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adScore, isAd } from './adFilter.ts';
import type { Article } from '../types.ts';

function article(p: Partial<Article>): Article {
  return {
    id: 'x', title: 'A normal headline', url: 'https://example.com/story',
    description: 'Plain description.', publishedAt: new Date(),
    source: 'Example', sourceId: 'ex', topics: ['general'],
    ...p,
  };
}

test('utm params alone do not flag an article', () => {
  const a = article({ url: 'https://example.com/story?utm_source=rss&utm_medium=feed' });
  assert.equal(isAd(a), false);
});

test('utm params plus a listicle title stay under the threshold', () => {
  const a = article({
    title: 'Best 5 hikes in Colorado',
    url: 'https://example.com/story?utm_source=rss&utm_campaign=feed',
  });
  assert.equal(isAd(a), false);
});

test('affiliate params still score strongly', () => {
  const a = article({ url: 'https://example.com/item?tag=somestore-20' });
  assert.ok(adScore(a) >= 6);
});

test('strong keywords still filter', () => {
  const a = article({ title: 'Huge coupon savings — sponsored' });
  assert.equal(isAd(a), true);
});
