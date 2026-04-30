import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseServerMsg, metaWorkerWsUrl, DEFAULT_META_WORKER_URL,
} from './metaWorker.ts';

describe('parseServerMsg', () => {
  it('parses a tags message', () => {
    const msg = parseServerMsg(JSON.stringify({ type: 'tags', articleId: 'abc', tags: ['ai'], updatedAt: 1 }));
    assert.deepStrictEqual(msg, { type: 'tags', articleId: 'abc', tags: ['ai'], updatedAt: 1 });
  });

  it('parses a catchUp reply', () => {
    const msg = parseServerMsg(JSON.stringify({ type: 'catchUp', updates: [] }));
    assert.deepStrictEqual(msg, { type: 'catchUp', updates: [] });
  });

  it('returns null for invalid JSON', () => {
    assert.strictEqual(parseServerMsg('{bad'), null);
  });

  it('returns null when type is missing', () => {
    assert.strictEqual(parseServerMsg(JSON.stringify({ articleId: 'x' })), null);
  });
});

describe('metaWorkerWsUrl', () => {
  it('converts https → wss', () => {
    assert.strictEqual(metaWorkerWsUrl('https://example.com'), 'wss://example.com/ws');
  });

  it('converts http → ws', () => {
    assert.strictEqual(metaWorkerWsUrl('http://localhost:8787'), 'ws://localhost:8787/ws');
  });

  it('default URL is https', () => {
    assert.ok(DEFAULT_META_WORKER_URL.startsWith('https://'));
  });
});
