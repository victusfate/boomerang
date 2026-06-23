import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleCapture } from './index.ts';
import { generateCaptureToken, resolveCaptureToken } from './token.ts';
import { storeTokenHash } from '../sync/auth.ts';

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

function makeCtx() {
  const waited: Array<Promise<unknown>> = [];
  return { waited, waitUntil: (p: Promise<unknown>) => { waited.push(p); }, passThroughOnException: () => {} };
}

function captureRequest(token: string, body: unknown): Request {
  return new Request(`https://w.test/api/capture/${token}`, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function makeR2() {
  const store = new Map<string, { body: string; etag: string }>();
  return {
    store,
    get: async (key: string) => {
      const o = store.get(key);
      if (!o) return null;
      return { text: async () => o.body, etag: o.etag };
    },
    put: async (key: string, body: string) => { store.set(key, { body, etag: 'e1' }); return { etag: 'e1' }; },
  };
}

async function ingest(kv: ReturnType<typeof makeKv>, token: string, body: unknown, r2?: ReturnType<typeof makeR2>): Promise<Response> {
  const env = { CAPTURE_TOKENS: kv, SYNC_BLOCKS: r2 ?? makeR2() } as never;
  return handleCapture(captureRequest(token, body), env, makeCtx() as never);
}

function tokenRequest(method: string, bearer: string | null, body: unknown): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  return new Request('https://w.test/api/capture/token', {
    method,
    headers,
    body: JSON.stringify(body),
  });
}

describe('handleCapture token management', () => {
  it('generates a capture token for a valid room bearer', async () => {
    const kv = makeKv();
    const r2 = makeR2();
    await storeTokenHash(r2 as never, 'room1', 'room-secret');
    const env = { CAPTURE_TOKENS: kv, SYNC_BLOCKS: r2 } as never;

    const res = await handleCapture(
      tokenRequest('POST', 'room-secret', { roomId: 'room1', destination: { type: 'saved-list' } }),
      env, makeCtx() as never,
    );

    assert.equal(res.status, 200);
    const json = await res.json() as { captureToken: string };
    assert.match(json.captureToken, /^[A-Za-z0-9_-]+$/);
    assert.ok(await resolveCaptureToken(kv as never, json.captureToken));
  });

  it('rejects token generation with an invalid bearer', async () => {
    const kv = makeKv();
    const r2 = makeR2();
    await storeTokenHash(r2 as never, 'room1', 'room-secret');
    const env = { CAPTURE_TOKENS: kv, SYNC_BLOCKS: r2 } as never;

    const res = await handleCapture(
      tokenRequest('POST', 'wrong', { roomId: 'room1', destination: { type: 'saved-list' } }),
      env, makeCtx() as never,
    );
    assert.equal(res.status, 401);
  });

  it('revokes a capture token for a valid room bearer', async () => {
    const kv = makeKv();
    const r2 = makeR2();
    await storeTokenHash(r2 as never, 'room1', 'room-secret');
    const { captureToken } = await generateCaptureToken(kv as never, 'room1', { type: 'saved-list' });
    const env = { CAPTURE_TOKENS: kv, SYNC_BLOCKS: r2 } as never;

    const res = await handleCapture(tokenRequest('DELETE', 'room-secret', { roomId: 'room1' }), env, makeCtx() as never);

    assert.equal(res.status, 204);
    assert.equal(await resolveCaptureToken(kv as never, captureToken), null);
  });

  it('rejects an unsupported destination type with 400', async () => {
    const kv = makeKv();
    const r2 = makeR2();
    await storeTokenHash(r2 as never, 'room1', 'room-secret');
    const env = { CAPTURE_TOKENS: kv, SYNC_BLOCKS: r2 } as never;

    const res = await handleCapture(
      tokenRequest('POST', 'room-secret', { roomId: 'room1', destination: { type: 'ftp' } }),
      env, makeCtx() as never,
    );
    assert.equal(res.status, 400);
  });
});

describe('handleCapture ingest', () => {
  it('accepts a valid capture for a known token with 204 and CORS', async () => {
    const kv = makeKv();
    const { captureToken } = await generateCaptureToken(kv as never, 'room1', { type: 'saved-list' });

    const res = await ingest(kv, captureToken, { url: 'https://example.com/a' });

    assert.equal(res.status, 204);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  });

  it('dispatches a saved-list capture into the room meta', async () => {
    const kv = makeKv();
    const r2 = makeR2();
    const { captureToken } = await generateCaptureToken(kv as never, 'roomXYZ', { type: 'saved-list' });

    const res = await ingest(kv, captureToken, { url: 'https://example.com/saved', title: 'Saved One' }, r2);

    assert.equal(res.status, 204);
    const meta = JSON.parse(r2.store.get('roomXYZ/meta')!.body);
    assert.equal(meta.savedArticles[0].url, 'https://example.com/saved');
    assert.equal(meta.savedArticles[0].title, 'Saved One');
  });

  it('dispatches a github capture asynchronously via waitUntil', async () => {
    const kv = makeKv();
    const { captureToken } = await generateCaptureToken(kv as never, 'roomG', {
      type: 'github', owner: 'o', repo: 'r', path: 'p.md', branch: 'main',
    });

    const originalFetch = globalThis.fetch;
    const fileBody = JSON.stringify({ content: Buffer.from('x\n').toString('base64'), sha: 's' });
    globalThis.fetch = (async () => new Response(fileBody, { status: 200 })) as typeof fetch;
    const ctx = makeCtx();
    try {
      const env = { CAPTURE_TOKENS: kv, SYNC_BLOCKS: makeR2(), GITHUB_PAT: 'pat' } as never;
      const res = await handleCapture(captureRequest(captureToken, { url: 'https://example.com/g' }), env, ctx as never);
      assert.equal(res.status, 204);
      assert.equal(ctx.waited.length, 1);
      await Promise.all(ctx.waited);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects an unknown token with 401', async () => {
    const kv = makeKv();
    const res = await ingest(kv, 'nope', { url: 'https://example.com/a' });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  });

  it('rejects an invalid url with 400', async () => {
    const kv = makeKv();
    const { captureToken } = await generateCaptureToken(kv as never, 'room1', { type: 'saved-list' });
    const res = await ingest(kv, captureToken, { url: 'ftp://x/y' });
    assert.equal(res.status, 400);
  });

  it('returns 429 once the rate limit is exceeded', async () => {
    const kv = makeKv();
    const { captureToken } = await generateCaptureToken(kv as never, 'room1', { type: 'saved-list' });
    let last: Response | undefined;
    for (let i = 0; i < 61; i++) {
      last = await ingest(kv, captureToken, { url: `https://example.com/${i}` });
    }
    assert.equal(last!.status, 429);
    assert.ok(Number(last!.headers.get('Retry-After')) > 0);
  });

  it('silently drops a duplicate url within the window with 204', async () => {
    const kv = makeKv();
    const { captureToken } = await generateCaptureToken(kv as never, 'room1', { type: 'saved-list' });

    const first = await ingest(kv, captureToken, { url: 'https://example.com/dup' });
    const second = await ingest(kv, captureToken, { url: 'https://example.com/dup' });

    assert.equal(first.status, 204);
    assert.equal(second.status, 204);
    const dedupKeys = [...kv.store.keys()].filter(k => k.startsWith('capture-dedup:'));
    assert.equal(dedupKeys.length, 1);
  });

  it('rejects a non-POST method with 405', async () => {
    const kv = makeKv();
    const { captureToken } = await generateCaptureToken(kv as never, 'room1', { type: 'saved-list' });
    const req = new Request(`https://w.test/api/capture/${captureToken}`, { method: 'GET' });
    const res = await handleCapture(req, { CAPTURE_TOKENS: kv } as never, makeCtx() as never);
    assert.equal(res.status, 405);
  });
});
