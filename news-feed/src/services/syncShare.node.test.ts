import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergePrefs } from './syncShare.ts';
import { DEFAULT_PREFS, MAX_READ_IDS, MAX_SEEN_IDS } from './storage.ts';
import type { UserPrefs } from '../types.ts';

function prefs(p: Partial<UserPrefs>): UserPrefs {
  return { ...DEFAULT_PREFS, ...p };
}

test('mergePrefs caps readIds at MAX_READ_IDS keeping most recent', () => {
  const left = prefs({ readIds: Array.from({ length: 800 }, (_, i) => `l${i}`) });
  const right = prefs({ readIds: Array.from({ length: 800 }, (_, i) => `r${i}`) });
  const merged = mergePrefs(left, right);
  assert.equal(merged.readIds.length, MAX_READ_IDS);
  // most-recent (tail) ids survive
  assert.ok(merged.readIds.includes('r799'));
});

test('mergePrefs caps seenIds at MAX_SEEN_IDS', () => {
  const left = prefs({ seenIds: Array.from({ length: 1500 }, (_, i) => `l${i}`) });
  const right = prefs({ seenIds: Array.from({ length: 1500 }, (_, i) => `r${i}`) });
  const merged = mergePrefs(left, right);
  assert.equal(merged.seenIds.length, MAX_SEEN_IDS);
  assert.ok(merged.seenIds.includes('r1499'));
});

test('mergePrefs under the caps keeps everything', () => {
  const left = prefs({ readIds: ['a'], seenIds: ['s1'] });
  const right = prefs({ readIds: ['b'], seenIds: ['s2'] });
  const merged = mergePrefs(left, right);
  assert.deepEqual(merged.readIds.sort(), ['a', 'b']);
  assert.deepEqual(merged.seenIds.sort(), ['s1', 's2']);
});
