import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchArticles, type SearchCandidate } from './articleSearch.ts';

function candidate(
  id: string,
  title: string,
  opts: Partial<SearchCandidate> = {},
): SearchCandidate {
  return {
    id,
    title,
    url: `https://example.com/${id}`,
    source: 'Test News',
    sourceId: 'test',
    publishedAt: '2025-01-01T00:00:00Z',
    inPool: true,
    inQueue: false,
    ...opts,
  };
}

test('empty query returns empty array', () => {
  const c = [candidate('a', 'Hello World')];
  assert.deepEqual(searchArticles('', c, 'all'), []);
});

test('whitespace-only query returns empty array', () => {
  assert.deepEqual(searchArticles('   ', [candidate('a', 'Hello')], 'all'), []);
});

test('exact title prefix match', () => {
  const results = searchArticles('Hello', [candidate('a', 'Hello World')], 'all');
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'a');
});

test('case-insensitive matching', () => {
  const results = searchArticles('hello', [candidate('a', 'Hello World')], 'all');
  assert.equal(results.length, 1);
});

test('no match returns empty array', () => {
  const results = searchArticles('xyz', [candidate('a', 'Hello World')], 'all');
  assert.equal(results.length, 0);
});

test('source name is matched', () => {
  const c = candidate('a', 'Some Article', { source: 'TechCrunch', sourceId: 'tc' });
  assert.equal(searchArticles('techcrunch', [c], 'all').length, 1);
  assert.equal(searchArticles('zzz', [c], 'all').length, 0);
});

test('prefix match ranks above word-prefix match', () => {
  const prefixMatch = candidate('prefix', 'Rust programming language');
  const wordPrefix = candidate('word', 'Learning Rust basics');
  const results = searchArticles('rust', [wordPrefix, prefixMatch], 'all');
  assert.equal(results[0].id, 'prefix');
  assert.equal(results[1].id, 'word');
});

test('word-prefix match ranks above substring match', () => {
  const wordPrefix = candidate('word', 'The Rust guide');
  const sub2 = candidate('sub2', 'Trust nobody');  // 'rust' appears mid-word
  const results = searchArticles('rust', [sub2, wordPrefix], 'all');
  assert.equal(results[0].id, 'word');
  assert.equal(results[1].id, 'sub2');
});

test('within same rank, sorts by publishedAt descending', () => {
  const older = { ...candidate('old', 'Rust tips'), publishedAt: '2024-01-01T00:00:00Z' };
  const newer = { ...candidate('new', 'Rust news'), publishedAt: '2025-06-01T00:00:00Z' };
  const results = searchArticles('rust', [older, newer], 'all');
  assert.equal(results[0].id, 'new');
  assert.equal(results[1].id, 'old');
});

test('deduplication: same id in pool and history → pool entry wins', () => {
  const poolEntry = candidate('dup', 'Shared Article', { inPool: true, inQueue: false });
  const histEntry = candidate('dup', 'Shared Article', { inPool: false, inQueue: false });
  const results = searchArticles('shared', [poolEntry, histEntry], 'all');
  assert.equal(results.length, 1);
  assert.equal(results[0].inPool, true);
});

test('scope feed returns only pool articles', () => {
  const poolOnly = candidate('p', 'React tips', { inPool: true, inQueue: false });
  const histOnly = candidate('h', 'React history', { inPool: false, inQueue: false });
  const results = searchArticles('react', [poolOnly, histOnly], 'feed');
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'p');
});

test('scope queue returns only queued articles', () => {
  const queued = candidate('q', 'Vue queue', { inPool: true, inQueue: true });
  const feed = candidate('f', 'Vue feed', { inPool: true, inQueue: false });
  const results = searchArticles('vue', [queued, feed], 'queue');
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'q');
});

test('scope history returns only history-only articles', () => {
  const histOnly = candidate('h', 'Angular history', { inPool: false, inQueue: false });
  const poolOnly = candidate('p', 'Angular now', { inPool: true, inQueue: false });
  const results = searchArticles('angular', [histOnly, poolOnly], 'history');
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'h');
});

test('scope all returns all matches', () => {
  const pool = candidate('p', 'Svelte pool', { inPool: true, inQueue: false });
  const queue = candidate('q', 'Svelte queue', { inPool: true, inQueue: true });
  const hist = candidate('h', 'Svelte history', { inPool: false, inQueue: false });
  const results = searchArticles('svelte', [pool, queue, hist], 'all');
  assert.equal(results.length, 3);
});
