import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { buildSyncUrl, parseSyncFragment, buildPayload, mergePayload } from './syncWorker';
import type { UserPrefs } from '../types';
import { DEFAULT_PREFS } from './storage';

const WORKER_URL = 'https://boomerang-sync.example.workers.dev';

function withFragment(fragment: string, fn: () => void) {
  const orig = (globalThis as any).location;
  Object.defineProperty(globalThis, 'location', {
    value: { hash: fragment, origin: 'https://example.com', pathname: '/boomerang/' },
    configurable: true,
  });
  try { fn(); } finally {
    Object.defineProperty(globalThis, 'location', { value: orig, configurable: true });
  }
}

describe('buildSyncUrl / parseSyncFragment round-trip', () => {
  test('encodes and decodes roomId, token, and workerUrl', () => {
    const roomId = 'a'.repeat(64);
    const token  = 'tok123';
    const url    = buildSyncUrl(WORKER_URL, roomId, token);
    const hash   = '#' + url.split('#')[1];

    withFragment(hash, () => {
      const parsed = parseSyncFragment();
      assert.ok(parsed !== null);
      assert.equal(parsed!.roomId, roomId);
      assert.equal(parsed!.token, token);
      assert.equal(parsed!.workerUrl, WORKER_URL);
    });
  });

  test('returns null when fragment is absent', () => {
    withFragment('', () => {
      assert.equal(parseSyncFragment(), null);
    });
  });

  test('returns null for unrelated fragment', () => {
    withFragment('#sync=somelegacyhash', () => {
      assert.equal(parseSyncFragment(), null);
    });
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
