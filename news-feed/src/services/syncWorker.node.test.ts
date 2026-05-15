import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  buildSyncFragment,
  parseSyncFragment,
  migrateLegacySyncRoom,
  buildPayload,
  autoSyncCompareKey,
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

const WORKER_URL = 'https://boomerang-platform.example.workers.dev';

describe('buildSyncUrl / parseSyncFragment round-trip', () => {
  test('builds compact fragment without worker URL', () => {
    const roomId = 'a'.repeat(64);
    const token  = 'tok123';
    const hash = buildSyncFragment(roomId, token);
    assert.equal(hash, `#sync-room=${roomId}:${token}`);
  });

  test('decodes compact fragment using configured worker URL', () => {
    const roomId = 'a'.repeat(64);
    const token  = 'tok123';
    const hash   = buildSyncFragment(roomId, token);
    const parsed = parseSyncFragment(hash, WORKER_URL);
    assert.ok(parsed !== null);
    assert.equal(parsed!.roomId, roomId);
    assert.equal(parsed!.token, token);
    assert.equal(parsed!.workerUrl, WORKER_URL);
  });

  test('decodes legacy fragment with embedded worker URL', () => {
    const roomId = 'd'.repeat(64);
    const token  = 'tok456';
    const hash = `#sync-room=${roomId}:${token}:${encodeURIComponent('http://127.0.0.1:8788')}`;
    const parsed = parseSyncFragment(hash, WORKER_URL);
    assert.ok(parsed !== null);
    assert.equal(parsed!.roomId, roomId);
    assert.equal(parsed!.token, token);
    assert.equal(parsed!.workerUrl, WORKER_URL);
  });

  test('returns null when fragment is absent', () => {
    assert.equal(parseSyncFragment(''), null);
  });

  test('returns null for compact fragment when worker base is missing', () => {
    const hash = buildSyncFragment('a'.repeat(64), 'tok123');
    assert.equal(parseSyncFragment(hash), null);
  });

  test('returns null for unrelated fragment', () => {
    assert.equal(parseSyncFragment('#sync=somelegacyhash'), null);
  });
});

describe('migrateLegacySyncRoom', () => {
  test('migrates local legacy sync worker port 8788', () => {
    const room = {
      roomId: 'a'.repeat(64),
      token: 'tok',
      workerUrl: 'http://127.0.0.1:8788',
    };
    const migrated = migrateLegacySyncRoom(room, 'http://localhost:8787');
    assert.equal(migrated.workerUrl, 'http://localhost:8787');
  });

  test('migrates legacy boomerang-sync cloud hostname', () => {
    const room = {
      roomId: 'b'.repeat(64),
      token: 'tok2',
      workerUrl: 'https://boomerang-sync.boomerang.workers.dev',
    };
    const migrated = migrateLegacySyncRoom(room, 'https://boomerang-platform.boomerang.workers.dev');
    assert.equal(migrated.workerUrl, 'https://boomerang-platform.boomerang.workers.dev');
  });

  test('does not rewrite already-modern URLs', () => {
    const room = {
      roomId: 'c'.repeat(64),
      token: 'tok3',
      workerUrl: 'https://boomerang-platform.boomerang.workers.dev',
    };
    const migrated = migrateLegacySyncRoom(room, 'https://boomerang-platform.boomerang.workers.dev');
    assert.equal(migrated.workerUrl, room.workerUrl);
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

  test('mergePayload keeps unsave when local unsavedAt is newer than remote savedAt', () => {
    const localPrefs: UserPrefs = {
      ...DEFAULT_PREFS,
      savedIds: [],
      savedAtById: {},
      unsavedAtById: { x: 200 },
    };
    const remotePrefs: UserPrefs = {
      ...DEFAULT_PREFS,
      savedIds: ['x'],
      savedAtById: { x: 100 },
      unsavedAtById: {},
    };
    const merged = mergePayload(
      { prefs: localPrefs, articleTags: [], labelHits: [], savedArticles: [] },
      buildPayload(remotePrefs, [], [], []),
    );
    assert.equal(merged.prefs.savedIds.includes('x'), false);
  });

  test('mergePayload restores save when remote savedAt is newer than local unsavedAt', () => {
    const localPrefs: UserPrefs = {
      ...DEFAULT_PREFS,
      savedIds: [],
      savedAtById: {},
      unsavedAtById: { x: 100 },
    };
    const remotePrefs: UserPrefs = {
      ...DEFAULT_PREFS,
      savedIds: ['x'],
      savedAtById: { x: 200 },
      unsavedAtById: {},
    };
    const merged = mergePayload(
      { prefs: localPrefs, articleTags: [], labelHits: [], savedArticles: [] },
      buildPayload(remotePrefs, [], [], []),
    );
    assert.equal(merged.prefs.savedIds.includes('x'), true);
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

  test('autoSyncCompareKey ignores seenIds/readIds churn (browse vs bookmark edits)', () => {
    const prefsBrowse: UserPrefs = {
      ...DEFAULT_PREFS,
      savedIds: ['a'],
      seenIds: [],
      readIds: [],
    };
    const prefsScroll: UserPrefs = {
      ...DEFAULT_PREFS,
      savedIds: ['a'],
      seenIds: ['s1', 's2'],
      readIds: ['r1'],
    };
    assert.equal(
      autoSyncCompareKey(prefsBrowse, [], [], []),
      autoSyncCompareKey(prefsScroll, [], [], []),
    );
    const prefsSaved: UserPrefs = { ...DEFAULT_PREFS, savedIds: ['a', 'b'], seenIds: [], readIds: [] };
    assert.notEqual(
      autoSyncCompareKey(prefsBrowse, [], [], []),
      autoSyncCompareKey(prefsSaved, [], [], []),
    );
  });
});
