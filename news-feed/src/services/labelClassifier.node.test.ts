import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPromptApiAvailable, classifyArticle, runClassificationPass } from './labelClassifier.ts';
import type { Article, UserLabel, LabelHit } from '../types.ts';

function mockArticle(id: string): Article {
  return {
    id,
    title: 'Test article title',
    url: 'https://example.com',
    description: 'A test description about AI.',
    publishedAt: new Date(),
    source: 'Test',
    sourceId: 'test',
    topics: ['technology'],
  };
}

function mockLabel(name: string): UserLabel {
  return { id: `lbl-${name}`, name, color: '#888888' };
}

test('isPromptApiAvailable returns false when LanguageModel not in globalThis', () => {
  assert.equal(isPromptApiAvailable(), false);
});

test('classifyArticle returns true when session responds YES', async () => {
  const session = { prompt: async (_: string) => 'YES' };
  const result = await classifyArticle(mockArticle('a1'), mockLabel('AI'), session);
  assert.equal(result, true);
});

test('classifyArticle returns false when session responds NO', async () => {
  const session = { prompt: async (_: string) => 'NO' };
  const result = await classifyArticle(mockArticle('a2'), mockLabel('AI'), session);
  assert.equal(result, false);
});

test('classifyArticle is case-insensitive (yes → true)', async () => {
  const session = { prompt: async (_: string) => 'yes' };
  const result = await classifyArticle(mockArticle('a3'), mockLabel('AI'), session);
  assert.equal(result, true);
});

test('runClassificationPass skips article already in existingHits', async () => {
  let createCalls = 0;
  (globalThis as any).LanguageModel = {
    create: async () => { createCalls++; return { prompt: async () => 'YES' }; },
  };
  const article = mockArticle('art-exists');
  const label = mockLabel('AI');
  const hit: LabelHit = { articleId: article.id, labelId: label.id, classifiedAt: 0 };
  const result = await runClassificationPass([article], label, [hit]);
  assert.equal(result.length, 0);
  assert.equal(createCalls, 0); // session never created
  delete (globalThis as any).LanguageModel;
});

test('runClassificationPass returns new hits for unclassified articles', async () => {
  (globalThis as any).LanguageModel = {
    create: async () => ({ prompt: async () => 'YES' }),
  };
  const article = mockArticle('art-new');
  const label = mockLabel('AI');
  const result = await runClassificationPass([article], label, []);
  assert.equal(result.length, 1);
  assert.equal(result[0].articleId, article.id);
  assert.equal(result[0].labelId, label.id);
  delete (globalThis as any).LanguageModel;
});

test('runClassificationPass returns empty when LanguageModel unavailable', async () => {
  const result = await runClassificationPass([mockArticle('a4')], mockLabel('AI'), []);
  assert.equal(result.length, 0);
});
