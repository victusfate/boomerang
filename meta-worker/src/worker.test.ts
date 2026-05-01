import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from './index';

async function req(method: string, path: string, origin = 'https://victusfate.github.io'): Promise<Response> {
  const headers = new Headers({ Origin: origin });
  const request = new Request(`http://localhost${path}`, { method, headers });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe('S1 — meta-worker scaffold', () => {
  it('GET /health → 200 with service name', async () => {
    const res = await req('GET', '/health');
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; service: string };
    expect(body).toMatchObject({ ok: true, service: 'boomerang-meta' });
  });

  it('OPTIONS preflight → 204 with CORS headers', async () => {
    const headers = new Headers({
      Origin: 'https://victusfate.github.io',
      'Access-Control-Request-Method': 'GET',
    });
    const request = new Request('http://localhost/health', { method: 'OPTIONS', headers });
    const ctx = createExecutionContext();
    const res = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://victusfate.github.io');
  });

  it('unknown path → 404', async () => {
    const res = await req('GET', '/nonexistent');
    expect(res.status).toBe(404);
  });

  it('GET /meta returns empty updates for missing ids', async () => {
    const res = await req('GET', '/meta?ids=missing-a,missing-b');
    expect(res.status).toBe(200);
    const body = await res.json() as { updates: unknown[] };
    expect(body.updates).toEqual([]);
  });

  it('POST /meta/tags writes and GET /meta returns merged tags', async () => {
    const post = await req('POST', '/meta/tags');
    expect(post.status).toBe(400);

    const writeReq = new Request('http://localhost/meta/tags', {
      method: 'POST',
      headers: new Headers({
        Origin: 'https://victusfate.github.io',
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({
        articles: [
          { articleId: 'a1', tags: ['AI', 'News'] },
          { articleId: 'a1', tags: ['news', 'ML'] },
        ],
      }),
    });
    const ctx = createExecutionContext();
    const writeRes = await worker.fetch(writeReq, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(writeRes.status).toBe(200);

    const readRes = await req('GET', '/meta?ids=a1');
    expect(readRes.status).toBe(200);
    const body = await readRes.json() as { updates: Array<{ articleId: string; tags: string[] }> };
    expect(body.updates).toHaveLength(1);
    expect(body.updates[0].articleId).toBe('a1');
    expect(body.updates[0].tags).toEqual(['ai', 'news', 'ml']);
  });

  it('GET /ws/ (trailing slash) without Upgrade → 426 like /ws', async () => {
    const res = await req('GET', '/ws/');
    expect(res.status).toBe(426);
  });
});
