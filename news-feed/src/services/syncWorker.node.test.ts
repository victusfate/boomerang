import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  buildSyncFragment,
  parseSyncFragment,
  buildPayload,
  mergePayload,
  mergeSavedArticleSnapshots,
  materializeSavedArticlesForSync,
  SYNC_PLACEHOLDER_SOURCE_ID,
} from './syncWorker.ts';
import type { Article, UserPrefs } from '../types.ts';
import { DEFAULT_PREFS } from './storage.ts';

function article(id: string, sourceId = 'src'): Article {
  return {
    id,
    title: `Title ${id}`,
    url: 'https://example.com/article',
    description: '',
    publishedAt: new Date('2026-01-01'),
    source: 's',
    sourceId,
    topics: ['general'],
  };
}

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

  test('buildPayload includes one savedArticles row per savedId (placeholders when unknown)', () => {
    const prefs: UserPrefs = { ...DEFAULT_PREFS, savedIds: ['a', 'b', 'c'] };
    const known: Article[] = [article('a')];
    const payload = buildPayload(prefs, [], [], known);
    assert.equal(payload.savedArticles.length, 3);
    const bodies = payload.savedArticles;
    const a = bodies.find(s => s.id === 'a');
    const b = bodies.find(s => s.id === 'b');
    assert.ok(a && a.sourceId === 'src');
    assert.ok(b && b.sourceId === SYNC_PLACEHOLDER_SOURCE_ID);
  });

  test('mergeSavedArticleSnapshots keeps local article when remote is placeholder', () => {
    const local = [article('x', 'bbc')];
    const remote = materializeSavedArticlesForSync(
      { ...DEFAULT_PREFS, savedIds: ['x'] },
      [],
    );
    assert.equal(remote[0].sourceId, SYNC_PLACEHOLDER_SOURCE_ID);
    const merged = mergeSavedArticleSnapshots(remote, local);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].sourceId, 'bbc');
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

  test('buildPayload normalizes duplicate/case-variant tags before sync push', () => {
    const payload = buildPayload(
      DEFAULT_PREFS,
      [{ articleId: 'x', tags: ['Politics', 'politics', ' UK ', 'uk'], taggedAt: 1 }],
      [],
      [],
    );
    assert.deepEqual(payload.articleTags[0].tags, ['politics', 'uk']);
  });
});
