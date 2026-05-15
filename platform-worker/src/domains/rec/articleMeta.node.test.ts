import { describe, it } from 'node:test';
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
