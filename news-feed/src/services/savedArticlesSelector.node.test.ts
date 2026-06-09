import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectSavedArticles } from './savedArticlesSelector.ts';
import { DEFAULT_PREFS } from './storage.ts';
import type { Article, UserPrefs } from '../types.ts';

function article(id: string, title = id): Article {
  return {
    id, title, url: `https://x.com/${id}`, description: '',
    publishedAt: new Date('2025-01-01'), source: 'S', sourceId: 's', topics: ['general'],
  };
}

function prefs(p: Partial<UserPrefs>): UserPrefs {
  return { ...DEFAULT_PREFS, ...p };
}

test('resolves saved ids from the pool', () => {
  const out = selectSavedArticles(prefs({ savedIds: ['a'] }), [article('a'), article('b')], []);
  assert.deepEqual(out.map(a => a.id), ['a']);
});

test('falls back to imported saves for out-of-pool ids; pool wins for shared ids', () => {
  const poolA = article('a', 'pool title');
  const importedA = article('a', 'imported title');
  const importedC = article('c');
  const out = selectSavedArticles(prefs({ savedIds: ['a', 'c'] }), [poolA], [importedA, importedC]);
  assert.equal(out.find(x => x.id === 'a')!.title, 'pool title');
  assert.ok(out.some(x => x.id === 'c'));
});

test('orders by savedAt desc, then star order for ties', () => {
  const p = prefs({
    savedIds: ['first', 'second', 'third'],
    savedAtById: { first: 100, second: 300, third: 200 },
  });
  const out = selectSavedArticles(p, [article('first'), article('second'), article('third')], []);
  assert.deepEqual(out.map(a => a.id), ['second', 'third', 'first']);
});

test('drops unresolvable ids', () => {
  const out = selectSavedArticles(prefs({ savedIds: ['ghost'] }), [], []);
  assert.deepEqual(out, []);
});
