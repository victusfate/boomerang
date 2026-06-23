import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { buildMailto } from './buildMailto.ts';

describe('buildMailto', () => {
  test('builds a mailto with a single item in the body', () => {
    const url = buildMailto([{ title: 'Hello World', url: 'https://example.com/a' }]);
    assert.ok(url.startsWith('mailto:?'));
    assert.ok(url.includes('subject=Hello%20World'));
    assert.ok(url.includes(encodeURIComponent('https://example.com/a')));
  });

  test('batches multiple items into the body, one block each', () => {
    const url = buildMailto([
      { title: 'First', url: 'https://example.com/1' },
      { title: 'Second', url: 'https://example.com/2' },
    ]);
    const body = decodeURIComponent(url.split('body=')[1]);
    assert.ok(body.includes('First'));
    assert.ok(body.includes('https://example.com/1'));
    assert.ok(body.includes('Second'));
    assert.ok(body.includes('https://example.com/2'));
  });

  test('uses an item-count subject for multiple items', () => {
    const url = buildMailto([
      { title: 'A', url: 'https://x/1' },
      { title: 'B', url: 'https://x/2' },
    ]);
    assert.ok(url.includes(`subject=${encodeURIComponent('2 saved pages from boomerang')}`));
  });

  test('encodes special characters in title and url', () => {
    const url = buildMailto([{ title: 'Tom & Jerry', url: 'https://x/s?q=a b&c=d' }]);
    assert.ok(!url.includes('Tom & Jerry'));
    assert.ok(url.includes(encodeURIComponent('Tom & Jerry')));
    assert.ok(url.includes(encodeURIComponent('https://x/s?q=a b&c=d')));
  });

  test('falls back to the url when an item has no title', () => {
    const url = buildMailto([{ title: '', url: 'https://example.com/notitle' }]);
    assert.ok(url.includes(encodeURIComponent('https://example.com/notitle')));
  });

  test('returns a mailto with an empty body for an empty list', () => {
    const url = buildMailto([]);
    assert.ok(url.startsWith('mailto:?'));
    assert.ok(url.endsWith('body='));
  });
});
