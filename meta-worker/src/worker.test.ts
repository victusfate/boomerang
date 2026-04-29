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
});
