import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PREFS, addUserLabel, deleteUserLabel, renameUserLabel } from './storage.ts';
import type { UserLabel } from '../types.ts';

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
