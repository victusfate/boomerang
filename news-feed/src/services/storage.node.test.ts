import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PREFS, addUserLabel, deleteUserLabel, renameUserLabel, clearQueue } from './storage.ts';
import type { UserLabel, UserPrefs } from '../types.ts';

function label(name: string): UserLabel {
  return { id: `lbl-${name}`, name, color: '#888888' };
}

test('addUserLabel appends a new label', () => {
  const next = addUserLabel(label('AI safety'), DEFAULT_PREFS);
  assert.equal(next.userLabels.length, 1);
  assert.equal(next.userLabels[0].name, 'AI safety');
});

test('addUserLabel ignores duplicate id', () => {
  const lbl = label('Rust');
  const once = addUserLabel(lbl, DEFAULT_PREFS);
  const twice = addUserLabel(lbl, once);
  assert.equal(twice.userLabels.length, 1);
});

test('deleteUserLabel removes by id', () => {
  const lbl = label('Climate');
  const withLabel = addUserLabel(lbl, DEFAULT_PREFS);
  const without = deleteUserLabel(lbl.id, withLabel);
  assert.equal(without.userLabels.length, 0);
});

test('renameUserLabel updates name, preserves id and color', () => {
  const lbl = label('Old name');
  const withLabel = addUserLabel(lbl, DEFAULT_PREFS);
  const renamed = renameUserLabel(lbl.id, 'New name', withLabel);
  assert.equal(renamed.userLabels[0].id, lbl.id);
  assert.equal(renamed.userLabels[0].name, 'New name');
  assert.equal(renamed.userLabels[0].color, lbl.color);
});

test('DEFAULT_PREFS has empty userLabels', () => {
  assert.deepEqual(DEFAULT_PREFS.userLabels, []);
});

// ── clearQueue ────────────────────────────────────────────────────────────────

function prefsWithSaved(...ids: string[]): UserPrefs {
  const savedAtById: Record<string, number> = {};
  ids.forEach((id, i) => { savedAtById[id] = 1000 + i; });
  return { ...DEFAULT_PREFS, savedIds: ids, savedAtById };
}

test('clearQueue empties savedIds and savedAtById', () => {
  const next = clearQueue(prefsWithSaved('a', 'b', 'c'));
  assert.deepEqual(next.savedIds, []);
  assert.deepEqual(next.savedAtById, {});
});

test('clearQueue records all cleared ids in unsavedAtById', () => {
  const before = prefsWithSaved('a', 'b');
  const next = clearQueue(before);
  const ua = next.unsavedAtById ?? {};
  assert.ok(typeof ua['a'] === 'number' && ua['a'] > 0);
  assert.ok(typeof ua['b'] === 'number' && ua['b'] > 0);
});

test('clearQueue preserves existing unsavedAtById entries', () => {
  const before: UserPrefs = { ...prefsWithSaved('a'), unsavedAtById: { old: 999 } };
  const next = clearQueue(before);
  const ua = next.unsavedAtById ?? {};
  assert.equal(ua['old'], 999);
  assert.ok(typeof ua['a'] === 'number');
});

test('clearQueue is a no-op when queue is already empty', () => {
  const next = clearQueue(DEFAULT_PREFS);
  assert.deepEqual(next.savedIds, []);
  assert.deepEqual(next.savedAtById, {});
});
