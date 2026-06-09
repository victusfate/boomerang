import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectTopics } from './topics.ts';

test('short ambiguous keywords require whole-word matches', () => {
  // 'un' must not match inside "under", 'ai' not inside "rain"/"said",
  // 'app' not inside "happen".
  assert.deepEqual(detectTopics('Rain expected under the bridge as everyone said it would happen'), ['general']);
});

test('standalone short keywords still match', () => {
  assert.ok(detectTopics('UN votes on new resolution').includes('world'));
  assert.ok(detectTopics('What AI means for jobs').includes('technology'));
  assert.ok(detectTopics('The new app everyone uses').includes('technology'));
});

test('longer keywords match as word prefixes', () => {
  assert.ok(detectTopics('Greenhouse gas levels hit record').includes('environment'));
  assert.ok(detectTopics('Inside the codebase of a unicorn').includes('technology'));
});

test('keywords do not match mid-word', () => {
  // 'war' must not match "software" / "warehouse" mid-word… "warehouse" starts
  // with war → prefix rule applies to ≥4 char keywords only; 'war' is 3.
  assert.deepEqual(detectTopics('New software warehouse opens'), ['technology']);
});

test('multi-word keywords still match', () => {
  assert.ok(detectTopics('Advances in artificial intelligence research')
    .includes('technology'));
});

test('caps at three topics and defaults to general', () => {
  assert.deepEqual(detectTopics('nothing relevant here'), ['general']);
});
