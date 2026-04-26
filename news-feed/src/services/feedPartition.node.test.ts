import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CustomSource, NewsSource } from '../types.ts';
import { partitionSourcesForSplitFetch } from './feedPartition.ts';

function src(id: string, p: 1 | 2): NewsSource {
  return {
    id,
    name: id,
    feedUrl: `https://example.com/${id}.xml`,
    category: 'technology',
    enabled: true,
    priority: p,
  };
}

test('partitionSourcesForSplitFetch splits p1 to fast, p2 and custom to background', () => {
  const sources: NewsSource[] = [src('a', 1), src('b', 1), src('c', 2)];
  const custom: CustomSource[] = [
    { id: 'custom-x1', name: 'X', feedUrl: 'https://c.example/x.xml' },
    { id: 'custom-y1', name: 'Y', feedUrl: 'https://c.example/y.xml' },
  ];
  const { fast, background } = partitionSourcesForSplitFetch(sources, custom);
  assert.deepEqual(fast.sources.map(s => s.id), ['a', 'b']);
  assert.equal(fast.custom.length, 0);
  assert.deepEqual(background.sources.map(s => s.id), ['c']);
  assert.equal(background.custom.length, 2);
});
