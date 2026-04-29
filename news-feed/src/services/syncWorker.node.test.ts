import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { buildSyncFragment, parseSyncFragment, buildPayload, mergePayload } from './syncWorker.ts';
import type { UserPrefs } from '../types.ts';
import { DEFAULT_PREFS } from './storage.ts';

const WORKER_URL = 'https://boomerang-sync.example.workers.dev';

describe('buildSyncUrl / parseSyncFragment round-trip', () => {
  test('encodes and decodes roomId, token, and workerUrl', () => {
    const roomId = 'a'.repeat(64);
    const token  = 'tok123';
    const hash   = buildSyncFragment(roomId, token, WORKER_URL);
    const parsed = parseSyncFragment(hash);
    assert.ok(parsed !== null);
    assert.equal(parsed!.roomId, roomId);
    assert.equal(parsed!.token, token);
    assert.equal(parsed!.workerUrl, WORKER_URL);
  });

  test('returns null when fragment is absent', () => {
    assert.equal(parseSyncFragment(''), null);
  });

  test('returns null for unrelated fragment', () => {
    assert.equal(parseSyncFragment('#sync=somelegacyhash'), null);
  });
});

describe('buildPayload / mergePayload', () => {
  const prefs: UserPrefs = { ...DEFAULT_PREFS, savedIds: ['art1'] };

  test('buildPayload sets v:1 and includes savedIds', () => {
    const payload = buildPayload(prefs, [], [], []);
    assert.equal(payload.v, 1);
    assert.ok(payload.prefs.savedIds.includes('art1'));
  });

  test('mergePayload unions savedIds from both sides', () => {
    const local  = buildPayload({ ...DEFAULT_PREFS, savedIds: ['a'] }, [], [], []);
    const remote = buildPayload({ ...DEFAULT_PREFS, savedIds: ['b'] }, [], [], []);
    const merged = mergePayload(
      { prefs: local.prefs, articleTags: [], labelHits: [], savedArticles: [] },
      remote,
    );
    assert.ok(merged.prefs.savedIds.includes('a'));
    assert.ok(merged.prefs.savedIds.includes('b'));
  });

  test('mergePayload deduplicates articleTags by articleId (newer wins)', () => {
    const older = { articleId: 'x', tags: ['old'], taggedAt: 1000 };
    const newer = { articleId: 'x', tags: ['new'], taggedAt: 2000 };
    const merged = mergePayload(
      { prefs: DEFAULT_PREFS, articleTags: [older], labelHits: [], savedArticles: [] },
      buildPayload(DEFAULT_PREFS, [newer], [], []),
    );
    assert.equal(merged.articleTags.length, 1);
    assert.deepEqual(merged.articleTags[0].tags, ['new']);
  });
});
