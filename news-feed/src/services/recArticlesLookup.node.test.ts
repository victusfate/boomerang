import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRecArticleMeta, parseRecArticlesResponse } from './recArticlesLookup.ts';

describe('parseRecArticlesResponse', () => {
  it('parses articles in request order with coverage fields', () => {
    const parsed = parseRecArticlesResponse({
      ok: true,
      requested: 3,
      found: 2,
      missing: ['missing-1'],
      articles: [
        { id: 'a', title: 'A', source: 'S', sourceId: 's', publishedAt: '2026-01-01', url: 'https://a' },
        { id: 'b', title: 'B', source: 'S', sourceId: 's', publishedAt: '2026-01-02', url: 'https://b' },
      ],
      timingMs: { kvLookup: 1, hydrate: 2, total: 3 },
    });
    assert.equal(parsed.requested, 3);
    assert.equal(parsed.found, 2);
    assert.deepEqual(parsed.missing, ['missing-1']);
    assert.equal(parsed.articles.length, 2);
    assert.deepEqual(parsed.timingMs, { kvLookup: 1, hydrate: 2, total: 3 });
  });

  it('filters invalid article rows', () => {
    const parsed = parseRecArticlesResponse({
      ok: true,
      requested: 2,
      found: 1,
      missing: ['x'],
      articles: [{ id: 'only-id' }, null],
    });
    assert.equal(parsed.articles.length, 0);
    assert.equal(parsed.found, 1);
  });
});

describe('normalizeRecArticleMeta', () => {
  it('returns null for partial records', () => {
    assert.equal(normalizeRecArticleMeta({ id: 'x', title: 't' }), null);
  });
});
