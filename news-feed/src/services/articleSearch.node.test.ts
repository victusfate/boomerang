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

// ── buildCandidates ──────────────────────────────────────────────────────────
import { buildCandidates, candidateToArticle, type PoolArticle } from './articleSearch.ts';

function pa(id: string, title: string): PoolArticle {
  return {
    id, title,
    url: `https://example.com/${id}`,
    source: 'Test News', sourceId: 'test',
    publishedAt: new Date('2025-01-01T00:00:00Z'),
  };
}

test('buildCandidates marks pool articles inPool and queue membership', () => {
  const pool = [pa('a', 'Alpha'), pa('b', 'Beta')];
  const saved = [pa('b', 'Beta')];
  const out = buildCandidates(pool, saved, []);
  const byId = new Map(out.map(c => [c.id, c]));
  assert.equal(byId.get('a')!.inPool, true);
  assert.equal(byId.get('a')!.inQueue, false);
  assert.equal(byId.get('b')!.inQueue, true);
});

test('buildCandidates includes out-of-pool saved articles as queue candidates', () => {
  const pool = [pa('a', 'Alpha')];
  const saved = [pa('imported', 'Imported Bookmark')];
  const out = buildCandidates(pool, saved, []);
  const imported = out.find(c => c.id === 'imported');
  assert.ok(imported, 'out-of-pool saved article must be a candidate');
  assert.equal(imported!.inPool, true);  // openable via onOpen
  assert.equal(imported!.inQueue, true);
});

test('buildCandidates adds history-only entries and skips ones already in pool', () => {
  const pool = [pa('a', 'Alpha')];
  const history = [
    { id: 'a', title: 'Alpha old', url: 'u', source: 's', publishedAt: '2024-01-01T00:00:00Z' },
    { id: 'h', title: 'Hist only', url: 'u2', source: 's2', publishedAt: '2024-02-01T00:00:00Z' },
  ];
  const out = buildCandidates(pool, [], history);
  assert.equal(out.filter(c => c.id === 'a').length, 1);
  assert.equal(out.find(c => c.id === 'a')!.title, 'Alpha'); // pool wins
  const h = out.find(c => c.id === 'h');
  assert.ok(h);
  assert.equal(h!.inPool, false);
});

test('buildCandidates skips history entries already saved out-of-pool', () => {
  const saved = [pa('x', 'Saved X')];
  const history = [{ id: 'x', title: 'X hist', url: 'u', source: 's', publishedAt: '2024-01-01T00:00:00Z' }];
  const out = buildCandidates([], saved, history);
  assert.equal(out.filter(c => c.id === 'x').length, 1);
  assert.equal(out[0].inQueue, true);
});

test('buildCandidates threads history sourceId through to candidates', () => {
  const history = [
    { id: 'h', title: 'Hist', url: 'u', source: 'BBC News', sourceId: 'bbc', publishedAt: '2024-01-01T00:00:00Z' },
    { id: 'h2', title: 'Old hist', url: 'u2', source: 's', publishedAt: '2024-01-01T00:00:00Z' },
  ];
  const out = buildCandidates([], [], history);
  assert.equal(out.find(c => c.id === 'h')!.sourceId, 'bbc');
  assert.equal(out.find(c => c.id === 'h2')!.sourceId, ''); // pre-sourceId entries degrade to ''
});

test('candidateToArticle synthesizes a minimal Article from a history candidate', () => {
  const c = candidate('h', 'Hist title', {
    inPool: false, source: 'BBC News', sourceId: 'bbc',
    url: 'https://example.com/h', publishedAt: '2024-03-01T00:00:00Z',
  });
  const a = candidateToArticle(c);
  assert.equal(a.id, 'h');
  assert.equal(a.title, 'Hist title');
  assert.equal(a.url, 'https://example.com/h');
  assert.equal(a.source, 'BBC News');
  assert.equal(a.sourceId, 'bbc');
  assert.equal(a.publishedAt.toISOString(), '2024-03-01T00:00:00.000Z');
  assert.deepEqual(a.topics, []);
  assert.equal(a.description, '');
});

test('buildCandidates dedupes duplicate ids within the history list', () => {
  const history = [
    { id: 'd', title: 'Local copy', url: 'u', source: 's', publishedAt: '2024-01-01T00:00:00Z' },
    { id: 'd', title: 'Remote copy', url: 'u', source: 's', publishedAt: '2024-01-01T00:00:00Z' },
  ];
  const out = buildCandidates([], [], history);
  assert.equal(out.filter(c => c.id === 'd').length, 1);
  assert.equal(out[0].title, 'Local copy'); // first wins
});
