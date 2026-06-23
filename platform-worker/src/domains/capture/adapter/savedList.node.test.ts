import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendToSavedList } from './savedList.ts';
import type { CaptureRecord } from '../types.ts';

const CAPTURE: CaptureRecord = {
  id: 'cap123',
  url: 'https://example.com/article',
  title: 'Captured Title',
  note: 'my note',
  ts: '2026-06-23T12:00:00.000Z',
  source: 'bookmarklet',
};

// R2 mock with etag/onlyIf semantics. failPuts forces N conditional puts to
// report a precondition failure (null) before succeeding, simulating 412s.
function makeR2(metaPayload: unknown, failPuts = 0) {
  const store = new Map<string, { body: string; etag: string }>();
  let etagSeq = 0;
  if (metaPayload !== undefined) {
    store.set('room1/meta', { body: JSON.stringify(metaPayload), etag: 'e0' });
  }
  let remainingFailures = failPuts;
  const putCalls: Array<{ key: string; opts?: { onlyIf?: { etagMatches?: string } } }> = [];
  return {
    store,
    putCalls,
    get: async (key: string) => {
      const o = store.get(key);
      if (!o) return null;
      return { text: async () => o.body, etag: o.etag };
    },
    put: async (key: string, body: string, opts?: { onlyIf?: { etagMatches?: string } }) => {
      putCalls.push({ key, opts });
      if (opts?.onlyIf?.etagMatches !== undefined && remainingFailures > 0) {
        remainingFailures -= 1;
        return null;
      }
      store.set(key, { body, etag: 'e' + ++etagSeq });
      return { etag: 'e' + etagSeq };
    },
  };
}

function readMeta(r2: ReturnType<typeof makeR2>): any {
  return JSON.parse(r2.store.get('room1/meta')!.body);
}

const EXISTING = {
  v: 1,
  prefs: { savedIds: ['old1'], savedAtById: { old1: 1 }, theme: 'dark' },
  savedArticles: [{ id: 'old1', title: 'Old', url: 'https://x/old' }],
  articleTags: [],
  labelHits: [],
};

describe('appendToSavedList', () => {
  it('prepends a capture article and saved id to existing meta', async () => {
    const r2 = makeR2(EXISTING);
    await appendToSavedList(r2 as never, 'room1', CAPTURE);

    const meta = readMeta(r2);
    assert.equal(meta.savedArticles[0].id, 'cap123');
    assert.equal(meta.savedArticles[0].title, 'Captured Title');
    assert.equal(meta.savedArticles[0].url, 'https://example.com/article');
    assert.equal(meta.savedArticles[0].source, 'Capture');
    assert.equal(meta.savedArticles[0].publishedAt, '2026-06-23T12:00:00.000Z');
    assert.equal(meta.prefs.savedIds[0], 'cap123');
    assert.equal(meta.prefs.savedAtById.cap123, Date.parse(CAPTURE.ts));
    // preserves prior data and unrelated fields
    assert.equal(meta.savedArticles[1].id, 'old1');
    assert.equal(meta.prefs.theme, 'dark');
  });

  it('writes conditionally on the read etag', async () => {
    const r2 = makeR2(EXISTING);
    await appendToSavedList(r2 as never, 'room1', CAPTURE);
    assert.equal(r2.putCalls[0].opts?.onlyIf?.etagMatches, 'e0');
  });

  it('retries once on a 412 conflict then succeeds', async () => {
    const r2 = makeR2(EXISTING, 1);
    await appendToSavedList(r2 as never, 'room1', CAPTURE);

    assert.equal(r2.putCalls.length, 2);
    assert.equal(readMeta(r2).savedArticles[0].id, 'cap123');
  });

  it('drops without throwing after a second conflict', async () => {
    const r2 = makeR2(EXISTING, 5);
    await appendToSavedList(r2 as never, 'room1', CAPTURE);

    assert.equal(r2.putCalls.length, 2);
    // original meta unchanged
    assert.equal(readMeta(r2).savedArticles[0].id, 'old1');
  });

  it('creates a fresh payload when no meta exists yet', async () => {
    const r2 = makeR2(undefined);
    await appendToSavedList(r2 as never, 'room1', CAPTURE);

    const meta = readMeta(r2);
    assert.equal(meta.v, 1);
    assert.equal(meta.savedArticles[0].id, 'cap123');
    assert.deepEqual(meta.prefs.savedIds, ['cap123']);
  });
});
