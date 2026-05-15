import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTICLE_RECORD_TTL_SECONDS,
  articleCatalogMissingTitleLabel,
  formatArticleCatalogCacheLabel,
} from '../../../shared/articleRecordCatalog.ts';

describe('articleRecordCatalog', () => {
  it('uses 6-month TTL', () => {
    assert.equal(ARTICLE_RECORD_TTL_SECONDS, 180 * 24 * 60 * 60);
    assert.equal(formatArticleCatalogCacheLabel(), '6 months');
  });

  it('formats missing-title label from TTL', () => {
    assert.equal(
      articleCatalogMissingTitleLabel(),
      '(article metadata outside of cache 6 months)',
    );
  });
});
