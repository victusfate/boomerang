import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import worker from './index';

// Helper to make requests through the worker
async function req(method: string, path: string, opts: {
  body?: BodyInit;
  token?: string;
  ifMatch?: string;
  contentType?: string;
} = {}): Promise<Response> {
  const headers = new Headers({ Origin: 'http://localhost:5173' });
  if (opts.token) headers.set('Authorization', `Bearer ${opts.token}`);
  if (opts.ifMatch) headers.set('If-Match', opts.ifMatch);
  if (opts.contentType) headers.set('Content-Type', opts.contentType);

  const request = new Request(`http://localhost${path}`, {
    method,
    headers,
    body: opts.body,
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe('health', () => {
  it('GET /health returns ok', async () => {
    const res = await req('GET', '/health');
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

describe('CORS', () => {
  it('OPTIONS returns 204 with CORS headers', async () => {
    const res = await req('OPTIONS', '/health');
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
  });
});

describe('POST /sync/room', () => {
  it('creates a room with roomId and token', async () => {
    const res = await req('POST', '/sync/room');
    expect(res.status).toBe(201);
    const body = await res.json() as { roomId: string; token: string };
    expect(body.roomId).toMatch(/^[0-9a-f]{64}$/);
    expect(body.token.length).toBeGreaterThan(20);
  });

  it('each POST produces a unique roomId', async () => {
    const a = await (await req('POST', '/sync/room')).json() as { roomId: string };
    const b = await (await req('POST', '/sync/room')).json() as { roomId: string };
    expect(a.roomId).not.toBe(b.roomId);
  });
});

describe('block storage', () => {
  let roomId: string;
  let token: string;

  beforeEach(async () => {
    const res = await (await req('POST', '/sync/room')).json() as { roomId: string; token: string };
    roomId = res.roomId;
    token = res.token;
  });

  it('PUT block with valid token → 201', async () => {
    const res = await req('PUT', `/sync/${roomId}/blocks/testcid123`, {
      token,
      body: new Uint8Array([1, 2, 3]),
    });
    expect(res.status).toBe(201);
  });

  it('PUT duplicate block → 204 (dedup)', async () => {
    await req('PUT', `/sync/${roomId}/blocks/deduptest`, { token, body: new Uint8Array([9]) });
    const res = await req('PUT', `/sync/${roomId}/blocks/deduptest`, { token, body: new Uint8Array([9]) });
    expect(res.status).toBe(204);
  });

  it('GET stored block returns same bytes', async () => {
    const bytes = new Uint8Array([10, 20, 30, 40]);
    await req('PUT', `/sync/${roomId}/blocks/roundtrip`, { token, body: bytes });
    const res = await req('GET', `/sync/${roomId}/blocks/roundtrip`);
    expect(res.status).toBe(200);
    const buf = await res.arrayBuffer();
    expect(new Uint8Array(buf)).toEqual(bytes);
  });

  it('GET unknown cid → 404', async () => {
    const res = await req('GET', `/sync/${roomId}/blocks/doesnotexist`);
    expect(res.status).toBe(404);
  });

  it('PUT without token → 401', async () => {
    const res = await req('PUT', `/sync/${roomId}/blocks/noauth`, { body: new Uint8Array([1]) });
    expect(res.status).toBe(401);
  });

  it('PUT with wrong token → 401', async () => {
    const res = await req('PUT', `/sync/${roomId}/blocks/wrongtoken`, {
      token: 'notthetoken',
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(401);
  });
});

describe('meta (clock head)', () => {
  let roomId: string;
  let token: string;

  beforeEach(async () => {
    const res = await (await req('POST', '/sync/room')).json() as { roomId: string; token: string };
    roomId = res.roomId;
    token = res.token;
  });

  it('GET empty room → 404', async () => {
    const res = await req('GET', `/sync/${roomId}/meta`);
    expect(res.status).toBe(404);
  });

  it('PUT meta → 200, GET returns same body + ETag', async () => {
    const payload = JSON.stringify({ head: ['cid1'] });
    const put = await req('PUT', `/sync/${roomId}/meta`, { token, body: payload });
    expect(put.status).toBe(200);

    const get = await req('GET', `/sync/${roomId}/meta`);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe(payload);
    expect(get.headers.get('ETag')).toBeTruthy();
  });

  it('PUT meta without token → 401', async () => {
    const res = await req('PUT', `/sync/${roomId}/meta`, { body: '{}' });
    expect(res.status).toBe(401);
  });

  it('PUT with stale If-Match → 412', async () => {
    await req('PUT', `/sync/${roomId}/meta`, { token, body: '{"head":["cid1"]}' });
    const res = await req('PUT', `/sync/${roomId}/meta`, {
      token,
      body: '{"head":["cid2"]}',
      ifMatch: '"stale-etag"',
    });
    expect(res.status).toBe(412);
  });

  it('PUT with correct If-Match → 200', async () => {
    await req('PUT', `/sync/${roomId}/meta`, { token, body: '{"head":["cid1"]}' });
    const get = await req('GET', `/sync/${roomId}/meta`);
    const etag = get.headers.get('ETag')!;

    const res = await req('PUT', `/sync/${roomId}/meta`, {
      token,
      body: '{"head":["cid2"]}',
      ifMatch: etag,
    });
    expect(res.status).toBe(200);
  });
});

describe('DELETE /sync/{roomId}', () => {
  it('deletes all room data', async () => {
    const { roomId, token } = await (await req('POST', '/sync/room')).json() as { roomId: string; token: string };
    await req('PUT', `/sync/${roomId}/blocks/blk1`, { token, body: new Uint8Array([1]) });
    await req('PUT', `/sync/${roomId}/meta`, { token, body: '{"head":[]}' });

    const del = await req('DELETE', `/sync/${roomId}`, { token });
    expect(del.status).toBe(200);

    expect((await req('GET', `/sync/${roomId}/blocks/blk1`)).status).toBe(404);
    expect((await req('GET', `/sync/${roomId}/meta`)).status).toBe(404);
  });

  it('DELETE without token → 401', async () => {
    const { roomId } = await (await req('POST', '/sync/room')).json() as { roomId: string };
    const res = await req('DELETE', `/sync/${roomId}`);
    expect(res.status).toBe(401);
  });
});
