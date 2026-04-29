import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLabels, suggestLabels } from './labelSuggester.ts';
import type { UserPrefs } from '../types.ts';

const EMPTY_PREFS: UserPrefs = {
  topicWeights: {}, sourceWeights: {}, keywordWeights: {},
  readIds: [], savedIds: [], seenIds: [], upvotedIds: [], downvotedIds: [],
  lastDecayAt: 0, enabledSources: [], disabledSourceIds: [], enabledTopics: [],
  customSources: [], userLabels: [], hideAiBar: false,
};

test('parseLabels splits newline-separated suggestions', () => {
  const result = parseLabels('AI Safety\nClimate Tech\nSpace Exploration');
  assert.deepEqual(result, ['AI Safety', 'Climate Tech', 'Space Exploration']);
});

test('parseLabels strips leading bullets and numbers', () => {
  const result = parseLabels('1. AI Safety\n- Climate Tech\n* Space');
  assert.deepEqual(result, ['AI Safety', 'Climate Tech', 'Space']);
});

test('parseLabels limits output to 5 labels', () => {
  const result = parseLabels('A\nB\nC\nD\nE\nF\nG');
  assert.equal(result.length, 5);
});

test('parseLabels filters blank lines', () => {
  const result = parseLabels('AI Safety\n\nClimate Tech');
  assert.deepEqual(result, ['AI Safety', 'Climate Tech']);
});

test('suggestLabels returns empty when LanguageModel unavailable', async () => {
  const result = await suggestLabels(EMPTY_PREFS, []);
  assert.deepEqual(result, []);
});

test('suggestLabels returns parsed labels from mock session', async () => {
  (globalThis as any).LanguageModel = {
    create: async () => ({
      prompt: async () => 'AI Safety\nClimate Tech\nCybersecurity',
    }),
  };
  const result = await suggestLabels(EMPTY_PREFS, []);
  assert.equal(result.length, 3);
  assert.equal(result[0], 'AI Safety');
  assert.equal(result[1], 'Climate Tech');
  delete (globalThis as any).LanguageModel;
});
