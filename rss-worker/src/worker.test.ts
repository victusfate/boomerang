import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
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

describe('S6 — buildTagsMap', () => {
  const TEST_ID = 'aabbccdd11223344';

  it('KV hit → returns tags for article', async () => {
    await env.ARTICLE_META.put(
      `meta:${TEST_ID}`,
      JSON.stringify({ articleId: TEST_ID, tags: ['ai', 'climate'], updatedAt: 1, contributors: 1 }),
    );
    const { buildTagsMap } = await import('./index');
    const map = await buildTagsMap([TEST_ID], env.ARTICLE_META);
    expect(map[TEST_ID]).toEqual(['ai', 'climate']);
  });

  it('KV miss → articleId absent from map', async () => {
    const { buildTagsMap } = await import('./index');
    const map = await buildTagsMap(['nosuchid00000000'], env.ARTICLE_META);
    expect(map['nosuchid00000000']).toBeUndefined();
  });

  it('empty id list → empty map', async () => {
    const { buildTagsMap } = await import('./index');
    const map = await buildTagsMap([], env.ARTICLE_META);
    expect(map).toEqual({});
  });
});
