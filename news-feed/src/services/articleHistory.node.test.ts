import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HISTORY_STORE_MAX,
  evictOldest,
  mergeEntry,
  type HistoryEntry,
} from './articleHistory.ts';

function entry(id: string, interactedAt: number): HistoryEntry {
  return { id, title: `Title ${id}`, url: `https://example.com/${id}`, source: 'Test', sourceId: 'test', publishedAt: '2025-01-01T00:00:00Z', interactedAt };
}

test('HISTORY_STORE_MAX is 500', () => {
  assert.equal(HISTORY_STORE_MAX, 500);
});

test('evictOldest returns all entries when under cap', () => {
  const entries = [entry('a', 1000), entry('b', 2000), entry('c', 3000)];
  const result = evictOldest(entries, 5);
  assert.equal(result.length, 3);
});

test('evictOldest drops oldest entries when over cap', () => {
  const entries = [entry('old', 1), entry('new', 3000), entry('mid', 2000)];
  const result = evictOldest(entries, 2);
  assert.equal(result.length, 2);
  const ids = result.map(e => e.id);
  assert.ok(ids.includes('new'));
  assert.ok(ids.includes('mid'));
  assert.ok(!ids.includes('old'));
});

test('evictOldest keeps exactly cap entries', () => {
  const entries = Array.from({ length: 501 }, (_, i) => entry(`id${i}`, i));
  const result = evictOldest(entries, 500);
  assert.equal(result.length, 500);
  assert.ok(!result.some(e => e.id === 'id0')); // oldest dropped
});

test('mergeEntry adds a new entry', () => {
  const result = mergeEntry([], entry('x', 100));
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'x');
});

test('mergeEntry updates interactedAt for existing id', () => {
  const existing = [entry('x', 100)];
  const result = mergeEntry(existing, entry('x', 999));
  assert.equal(result.length, 1);
  assert.equal(result[0].interactedAt, 999);
});

test('mergeEntry updates title for existing id', () => {
  const existing = [{ ...entry('x', 100), title: 'Old Title' }];
  const updated = { ...entry('x', 200), title: 'New Title' };
  const result = mergeEntry(existing, updated);
  assert.equal(result[0].title, 'New Title');
});

test('mergeEntry preserves other entries when updating', () => {
  const existing = [entry('a', 100), entry('b', 200)];
  const result = mergeEntry(existing, entry('a', 999));
  assert.equal(result.length, 2);
  assert.ok(result.some(e => e.id === 'b'));
});
