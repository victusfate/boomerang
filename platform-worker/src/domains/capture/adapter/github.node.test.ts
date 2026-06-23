import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendToGithub } from './github.ts';
import type { CaptureRecord } from '../types.ts';

const CONFIG = { owner: 'octo', repo: 'notes', path: 'reading.md', branch: 'main' };
const CAPTURE: CaptureRecord = {
  id: 'cap1',
  url: 'https://example.com/post',
  title: 'A Post',
  note: 'great read',
  ts: '2026-06-23T12:00:00.000Z',
  source: 'bookmarklet',
};

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}
function fromB64(b: string): string {
  return Buffer.from(b, 'base64').toString('utf8');
}

// Scripted fetch: queue of responses, records each call.
function makeFetch(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[i++] ?? { status: 500 };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  };
  return Object.assign(fn, { calls });
}

describe('appendToGithub', () => {
  it('reads the file, appends an entry, and commits with the sha', async () => {
    const fetchFn = makeFetch([
      { status: 200, body: { content: b64('# Reading\n'), sha: 'sha-abc' } },
      { status: 200, body: { content: 'whatever' } },
    ]);

    await appendToGithub(fetchFn as never, 'PAT123', CONFIG, CAPTURE);

    // GET targets the contents API on the right branch
    assert.equal(
      fetchFn.calls[0].url,
      'https://api.github.com/repos/octo/notes/contents/reading.md?ref=main',
    );
    // PUT payload
    const put = fetchFn.calls[1];
    assert.equal(put.init?.method, 'PUT');
    const body = JSON.parse(put.init!.body as string);
    assert.equal(body.sha, 'sha-abc');
    assert.equal(body.branch, 'main');
    const written = fromB64(body.content);
    assert.match(written, /^# Reading\n/);
    assert.match(
      written,
      /- \[ \] A Post — https:\/\/example\.com\/post {2}<!-- note: great read \| ts: 2026-06-23T12:00:00\.000Z -->/,
    );
    // auth header present
    assert.equal((put.init?.headers as Record<string, string>).Authorization, 'Bearer PAT123');
  });

  it('creates the file with no sha when it does not yet exist', async () => {
    const fetchFn = makeFetch([
      { status: 404, body: { message: 'Not Found' } },
      { status: 201, body: { content: 'x' } },
    ]);

    await appendToGithub(fetchFn as never, 'PAT', CONFIG, CAPTURE);

    const body = JSON.parse(fetchFn.calls[1].init!.body as string);
    assert.equal(body.sha, undefined);
    assert.match(fromB64(body.content), /- \[ \] A Post/);
  });

  it('retries once on a 409 sha conflict then succeeds', async () => {
    const fetchFn = makeFetch([
      { status: 200, body: { content: b64('start\n'), sha: 'sha-1' } },
      { status: 409, body: { message: 'conflict' } },
      { status: 200, body: { content: b64('start\n'), sha: 'sha-2' } },
      { status: 200, body: { content: 'ok' } },
    ]);

    await appendToGithub(fetchFn as never, 'PAT', CONFIG, CAPTURE);

    assert.equal(fetchFn.calls.length, 4);
    const finalPut = JSON.parse(fetchFn.calls[3].init!.body as string);
    assert.equal(finalPut.sha, 'sha-2');
  });
});
