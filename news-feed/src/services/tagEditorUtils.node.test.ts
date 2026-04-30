import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addManualTag, removeManualTag } from './tagEditorUtils.ts';

describe('addManualTag', () => {
  it('adds a new tag', () => {
    assert.deepStrictEqual(addManualTag(['ai'], 'tech'), ['ai', 'tech']);
  });

  it('normalises to lowercase and trims', () => {
    assert.deepStrictEqual(addManualTag([], '  AI  '), ['ai']);
  });

  it('ignores empty string', () => {
    assert.deepStrictEqual(addManualTag(['ai'], ''), ['ai']);
    assert.deepStrictEqual(addManualTag(['ai'], '   '), ['ai']);
  });

  it('deduplicates — does not add if tag already present', () => {
    assert.deepStrictEqual(addManualTag(['ai'], 'ai'), ['ai']);
    assert.deepStrictEqual(addManualTag(['ai'], 'AI'), ['ai']);
  });
});

describe('removeManualTag', () => {
  it('removes the matching tag', () => {
    assert.deepStrictEqual(removeManualTag(['ai', 'tech'], 'ai'), ['tech']);
  });

  it('returns empty array when last tag is removed', () => {
    assert.deepStrictEqual(removeManualTag(['ai'], 'ai'), []);
  });

  it('preserves other tags when tag is not present', () => {
    assert.deepStrictEqual(removeManualTag(['ai', 'tech'], 'missing'), ['ai', 'tech']);
  });
});
