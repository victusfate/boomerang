import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { buildCaptureEndpoint, buildSaveUrl, buildBookmarklet } from './captureWorker.ts';

const WORKER = 'https://boomerang-platform.example.workers.dev';
const TOKEN = 'capTok_123-ABC';

describe('buildCaptureEndpoint', () => {
  test('joins worker url and token into the ingest path', () => {
    assert.equal(
      buildCaptureEndpoint(WORKER, TOKEN),
      `${WORKER}/api/capture/${TOKEN}`,
    );
  });

  test('strips a trailing slash on the worker url', () => {
    assert.equal(
      buildCaptureEndpoint(`${WORKER}/`, TOKEN),
      `${WORKER}/api/capture/${TOKEN}`,
    );
  });
});

describe('buildSaveUrl', () => {
  test('joins worker url and token into the save path', () => {
    assert.equal(buildSaveUrl(WORKER, TOKEN), `${WORKER}/save/${TOKEN}`);
  });

  test('strips a trailing slash on the worker url', () => {
    assert.equal(buildSaveUrl(`${WORKER}/`, TOKEN), `${WORKER}/save/${TOKEN}`);
  });
});

describe('buildBookmarklet', () => {
  test('produces a javascript: snippet that navigates to the save page', () => {
    const code = buildBookmarklet(WORKER, TOKEN);
    assert.ok(code.startsWith('javascript:'));
    assert.ok(code.includes(`${WORKER}/save/${TOKEN}`));
    assert.ok(!code.includes('window.open'), 'must not use window.open — blocked on mobile');
  });

  test('captures location, title and selection and sends them', () => {
    const code = buildBookmarklet(WORKER, TOKEN);
    assert.ok(code.includes('location.href'));
    assert.ok(code.includes('document.title'));
    assert.ok(code.includes('getSelection'));
  });

  test('returns empty string when token is missing', () => {
    assert.equal(buildBookmarklet(WORKER, ''), '');
  });
});
