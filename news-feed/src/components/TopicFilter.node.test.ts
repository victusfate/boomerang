import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFilterState, SHOWN_TOPICS } from './topicFilterUtils.ts';
import type { UserLabel } from '../types.ts';

function label(name: string): UserLabel {
  return { id: `lbl-${name}`, name, color: '#888888' };
}

test('with no labels, showMoreButton is false and all topics are shown inline', () => {
  const { labelPills, topicPills, showMoreButton } = buildFilterState([]);
  assert.equal(labelPills.length, 0);
  assert.deepEqual(topicPills, SHOWN_TOPICS);
  assert.equal(showMoreButton, false);
});

test('with labels, label pills appear and showMoreButton is true', () => {
  const labels = [label('AI'), label('Climate')];
  const { labelPills, topicPills, showMoreButton } = buildFilterState(labels);
  assert.equal(labelPills[0].id, 'lbl-AI');
  assert.equal(labelPills[1].id, 'lbl-Climate');
  assert.equal(topicPills.length, SHOWN_TOPICS.length);
  assert.equal(showMoreButton, true);
});

test('label pills order preserved as supplied', () => {
  const labels = [label('Z'), label('A')];
  const { labelPills } = buildFilterState(labels);
  assert.equal(labelPills[0].id, 'lbl-Z');
  assert.equal(labelPills[1].id, 'lbl-A');
});
