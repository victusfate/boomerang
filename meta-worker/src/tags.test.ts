import { describe, it, expect } from 'vitest';
import { normaliseTags, mergeTagSets } from './tags';

describe('normaliseTags', () => {
  it('lowercases and trims', () => {
    expect(normaliseTags(['  AI ', 'Climate'])).toEqual(['ai', 'climate']);
  });

  it('deduplicates', () => {
    expect(normaliseTags(['ai', 'AI', ' ai '])).toEqual(['ai']);
  });

  it('drops empty strings', () => {
    expect(normaliseTags(['', '  ', 'tech'])).toEqual(['tech']);
  });
});

describe('mergeTagSets', () => {
  it('unions two sets without duplicates', () => {
    expect(mergeTagSets(['ai', 'climate'], ['climate', 'tech'])).toEqual(['ai', 'climate', 'tech']);
  });

  it('handles empty inputs', () => {
    expect(mergeTagSets([], ['a'])).toEqual(['a']);
    expect(mergeTagSets(['a'], [])).toEqual(['a']);
  });
});
