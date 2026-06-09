import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchMetaTags, submitMetaTags,
} from './metaWorker.ts';

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
