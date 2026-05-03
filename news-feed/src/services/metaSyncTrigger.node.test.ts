import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sameIdsInOrder } from './metaSyncTrigger.ts';

test('sameIdsInOrder returns true for identical id arrays', () => {
  assert.equal(sameIdsInOrder(['a1', 'a2'], ['a1', 'a2']), true);
});

test('sameIdsInOrder returns false when lengths differ', () => {
  assert.equal(sameIdsInOrder(['a1'], ['a1', 'a2']), false);
});

test('sameIdsInOrder returns false when order differs', () => {
  assert.equal(sameIdsInOrder(['a1', 'a2'], ['a2', 'a1']), false);
});
