import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isDuplicate, markSeen, DEDUP_TTL_SECONDS } from './dedupe.ts';

function makeKv() {
  const store = new Map<string, string>();
  const putOpts: Array<{ key: string; opts?: { expirationTtl?: number } }> = [];
  return {
    store,
    putOpts,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      store.set(key, value);
      putOpts.push({ key, opts });
    },
    delete: async (key: string) => { store.delete(key); },
  };
}

describe('capture dedupe', () => {
  it('reports a url as not duplicate before it is seen', async () => {
    const kv = makeKv();
    assert.equal(await isDuplicate(kv as never, 'tok', 'https://x.test/a'), false);
  });

  it('reports a url as duplicate after it is marked seen', async () => {
    const kv = makeKv();
    await markSeen(kv as never, 'tok', 'https://x.test/a');
    assert.equal(await isDuplicate(kv as never, 'tok', 'https://x.test/a'), true);
  });

  it('writes the dedupe key with a 5-minute TTL', async () => {
    const kv = makeKv();
    await markSeen(kv as never, 'tok', 'https://x.test/a');
    assert.equal(kv.putOpts.length, 1);
    assert.equal(kv.putOpts[0].opts?.expirationTtl, DEDUP_TTL_SECONDS);
    assert.equal(DEDUP_TTL_SECONDS, 300);
  });

  it('treats different urls independently', async () => {
    const kv = makeKv();
    await markSeen(kv as never, 'tok', 'https://x.test/a');
    assert.equal(await isDuplicate(kv as never, 'tok', 'https://x.test/b'), false);
  });

  it('treats the same url under different tokens independently', async () => {
    const kv = makeKv();
    await markSeen(kv as never, 'tokA', 'https://x.test/a');
    assert.equal(await isDuplicate(kv as never, 'tokB', 'https://x.test/a'), false);
  });
});
