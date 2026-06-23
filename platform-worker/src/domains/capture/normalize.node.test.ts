import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBody, NOTE_MAX_BYTES } from './normalize.ts';

describe('normalizeBody', () => {
  it('parses a valid body into a CaptureRecord with server-set id and ts', () => {
    const before = Date.now();
    const record = normalizeBody(JSON.stringify({
      url: 'https://example.com/post',
      title: '  A Title  ',
      note: '  context  ',
      source: 'bookmarklet',
      ts: '1999-01-01T00:00:00.000Z',
    }));

    assert.ok(record);
    assert.equal(record.url, 'https://example.com/post');
    assert.equal(record.title, 'A Title');
    assert.equal(record.note, 'context');
    assert.equal(record.source, 'bookmarklet');
    assert.match(record.id, /^[A-Za-z0-9_-]+$/);
    // client-supplied ts is ignored; server stamps its own
    assert.notEqual(record.ts, '1999-01-01T00:00:00.000Z');
    assert.ok(Date.parse(record.ts) >= before);
  });

  it('returns null for invalid JSON', () => {
    assert.equal(normalizeBody('{not json'), null);
  });

  it('returns null for a non-http(s) url', () => {
    assert.equal(normalizeBody(JSON.stringify({ url: 'ftp://x/y' })), null);
    assert.equal(normalizeBody(JSON.stringify({ url: 'javascript:alert(1)' })), null);
    assert.equal(normalizeBody(JSON.stringify({ url: 42 })), null);
    assert.equal(normalizeBody(JSON.stringify({})), null);
  });

  it('defaults title, note and source when absent', () => {
    const record = normalizeBody(JSON.stringify({ url: 'http://x.test/' }));
    assert.ok(record);
    assert.equal(record.title, '');
    assert.equal(record.note, '');
    assert.equal(record.source, 'bookmarklet');
  });

  it('caps note at NOTE_MAX_BYTES', () => {
    const huge = 'x'.repeat(NOTE_MAX_BYTES + 5000);
    const record = normalizeBody(JSON.stringify({ url: 'https://x.test/', note: huge }));
    assert.ok(record);
    assert.ok(Buffer.byteLength(record.note, 'utf8') <= NOTE_MAX_BYTES);
  });
});
