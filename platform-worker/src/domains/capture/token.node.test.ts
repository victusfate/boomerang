import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateCaptureToken,
  revokeCaptureToken,
  resolveCaptureToken,
} from './token.ts';

// Mock KV: Map-backed. get(key,'json') parses; put stores raw string; delete removes.
function makeKv(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    get: async (key: string, type?: string) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    put: async (key: string, value: string) => { store.set(key, value); },
    delete: async (key: string) => { store.delete(key); },
  };
}

const SAVED_LIST = { type: 'saved-list' } as const;

describe('generateCaptureToken', () => {
  it('writes a forward record resolvable by the returned token', async () => {
    const kv = makeKv();
    const { captureToken } = await generateCaptureToken(kv as never, 'room1', SAVED_LIST);

    assert.match(captureToken, /^[A-Za-z0-9_-]+$/);
    const record = await resolveCaptureToken(kv as never, captureToken);
    assert.deepEqual(record, { roomId: 'room1', destinationType: 'saved-list' });
  });

  it('rotates: deletes the prior forward key for the same room', async () => {
    const kv = makeKv();
    const first = await generateCaptureToken(kv as never, 'room1', SAVED_LIST);
    const second = await generateCaptureToken(kv as never, 'room1', SAVED_LIST);

    assert.notEqual(first.captureToken, second.captureToken);
    assert.equal(await resolveCaptureToken(kv as never, first.captureToken), null);
    assert.ok(await resolveCaptureToken(kv as never, second.captureToken));
  });
});

describe('revokeCaptureToken', () => {
  it('deletes both the forward record and the reverse index', async () => {
    const kv = makeKv();
    const { captureToken } = await generateCaptureToken(kv as never, 'room1', SAVED_LIST);

    await revokeCaptureToken(kv as never, 'room1');

    assert.equal(await resolveCaptureToken(kv as never, captureToken), null);
    assert.equal(kv.store.get('capture-room:room1'), undefined);
  });

  it('is a no-op when no token exists for the room', async () => {
    const kv = makeKv();
    await revokeCaptureToken(kv as never, 'ghost');
    assert.equal(kv.store.size, 0);
  });
});

describe('resolveCaptureToken', () => {
  it('returns null for an unknown token', async () => {
    const kv = makeKv();
    assert.equal(await resolveCaptureToken(kv as never, 'nope'), null);
  });
});
