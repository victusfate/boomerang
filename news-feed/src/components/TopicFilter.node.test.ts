import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SHOWN_TOPICS, TOPIC_META } from './topicFilterUtils.ts';

test('SHOWN_TOPICS covers every topic except general', () => {
  assert.ok(SHOWN_TOPICS.length > 0);
  assert.ok(!(SHOWN_TOPICS as string[]).includes('general'));
  assert.equal(SHOWN_TOPICS.length, Object.keys(TOPIC_META).length - 1);
});
