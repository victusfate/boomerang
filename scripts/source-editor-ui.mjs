#!/usr/bin/env node
/**
 * RSS source editor — local debug UI
 *
 * Usage:  node scripts/source-editor-ui.mjs
 * Opens:  http://localhost:3456/
 *
 * Features
 *   • View all sources with poll verdicts (run poll first or click Run Poll)
 *   • Keep / Cut toggle per source (Cut removes on Save)
 *   • Enable / Disable toggle (sets enabled field without removing the source)
 *   • Add new source via modal
 *   • Save writes back to shared/rss-sources.json
 *   • Run Poll streams live output and reloads verdicts when done
 *
 * HTML template: source-editor-ui-html.mjs
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';
import { HTML } from './source-editor-ui-html.mjs';

const __dir     = dirname(fileURLToPath(import.meta.url));
const SOURCES   = resolve(__dir, '../shared/rss-sources.json');
const RESULTS   = resolve(__dir, '../shared/rss-sources.results.json');
const SERVER_PORT = 3456;

const CATEGORIES = ['technology', 'world', 'science', 'environment', 'sports', 'entertainment', 'general'];

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${SERVER_PORT}`);

  if (req.method === 'GET' && url.pathname === '/') {
    // quality-ok: magic-number — HTTP 200 OK status code
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/data') {
    const src = JSON.parse(readFileSync(SOURCES, 'utf-8'));
    const res2 = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf-8')) : null;
    // quality-ok: magic-number — HTTP 200 OK status code
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sources: src, results: res2?.results ?? null }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/save') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        writeFileSync(SOURCES, JSON.stringify(parsed, null, 2) + '\n');
        // quality-ok: magic-number — HTTP 200 OK status code
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        // quality-ok: magic-number — HTTP 400 Bad Request status code
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/poll') {
    // quality-ok: magic-number — HTTP 200 OK status code
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');

    const child = spawn('node', [resolve(__dir, 'poll-rss-feeds.mjs')], {
      cwd: resolve(__dir, '..'),
    });
    const send = d => res.write('data: ' + JSON.stringify(d) + '\n\n');
    child.stdout.on('data', d => send({ type: 'out', text: d.toString() }));
    child.stderr.on('data', d => send({ type: 'err', text: d.toString() }));
    child.on('close', code => { send({ type: 'done', code }); res.end(); });
    req.on('close', () => child.kill());
    return;
  }

  // quality-ok: magic-number — HTTP 404 Not Found status code
  res.writeHead(404);
  res.end('Not found');
});

server.listen(SERVER_PORT, () => {
  console.log('\nRSS Source Editor');
  console.log('─────────────────────────────────');
  console.log(`  http://localhost:${SERVER_PORT}/`);
  console.log('');
  console.log('  Run poll first to get verdicts:');
  console.log('    node scripts/poll-rss-feeds.mjs');
  console.log('  …or click "Run Poll" in the UI.');
  console.log('');
  console.log('  Press Ctrl+C to stop.\n');
});
