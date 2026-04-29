import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from './index';

const ORIGIN = 'http://localhost:4173';

async function req(method: string, path: string): Promise<Response> {
  const request = new Request(`http://localhost${path}`, {
    method,
    headers: { Origin: ORIGIN },
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
    const body = await res.json() as { ok: boolean; service: string };
    expect(body.ok).toBe(true);
    expect(body.service).toBe('boomerang-rss');
  });
});

describe('CORS', () => {
  it('OPTIONS preflight returns 204', async () => {
    const res = await req('OPTIONS', '/bundle');
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  });
});

describe('bundle route', () => {
  it('GET /bundle?include=__none__ returns 400', async () => {
    const res = await req('GET', '/bundle?include=__none__');
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(false);
  });
});

describe('404', () => {
  it('unknown path returns 404', async () => {
    const res = await req('GET', '/unknown');
    expect(res.status).toBe(404);
  });
});
