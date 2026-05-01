import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseServerMsg, metaWorkerWsUrl, fetchMetaTags, submitMetaTags,
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
});

describe('meta HTTP helpers', () => {
  it('fetchMetaTags requests deduped ids and returns updates', async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = '';
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ updates: [{ articleId: 'a1', tags: ['ai'], updatedAt: 1 }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const updates = await fetchMetaTags('https://meta.example.workers.dev', ['a1', 'a1', 'a2']);
      assert.equal(updates.length, 1);
      assert.ok(requestedUrl.includes('/meta?ids='));
      assert.ok(requestedUrl.includes('a1%2Ca2'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('submitMetaTags POSTs batch payload', async () => {
    const originalFetch = globalThis.fetch;
    let method = '';
    let body = '';
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      method = init?.method ?? '';
      body = String(init?.body ?? '');
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      await submitMetaTags('https://meta.example.workers.dev', [{ articleId: 'a1', tags: ['ai'] }]);
      assert.equal(method, 'POST');
      assert.ok(body.includes('articleId'));
      assert.ok(body.includes('a1'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
