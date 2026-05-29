#!/usr/bin/env node
// Generates docs/api/ directory with:
//   api-rest.md   — REST API reference in Markdown
//   api-rest.html — REST API reference as standalone HTML
//   index.html    — landing page linking to TypeDoc and REST docs
// Run via: node --experimental-strip-types scripts/gen-api-docs.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// ── Load route registry ────────────────────────────────────────────────────
// Import the TypeScript file using --experimental-strip-types (Node ≥22).
// The file has no Cloudflare-specific runtime imports, so it's safe here.
const { API_ROUTES } = await import(
  join(root, 'platform-worker/src/apiRoutes.ts')
);

// ── Markdown renderers ─────────────────────────────────────────────────────

function methodBadge(method) {
  const m = Array.isArray(method) ? method.join(' / ') : method;
  return `**\`${m}\`**`;
}

function renderRoute(r) {
  const lines = [
    `### ${methodBadge(r.method)} \`${r.path}\``,
    '',
    r.summary,
  ];
  if (r.auth)      lines.push('', `**Auth:** ${r.auth}`);
  if (r.rateLimit) lines.push('', `**Rate limit:** ${r.rateLimit}`);
  if (r.request)   lines.push('', `**Request:** ${r.request}`);
  lines.push('', `**Response:** ${r.response}`);
  if (r.notes)     lines.push('', `> ${r.notes}`);
  lines.push('');
  return lines.join('\n');
}

const sections = {
  'Health': [],
  'RSS': [],
  'Sync': [],
  'Meta': [],
  'Rec': [],
};

const sectionByPrefix = {
  '/health': 'Health',
  '/bundle': 'RSS',
  '/og-image': 'RSS',
  '/image': 'RSS',
  '/sync': 'Sync',
  '/meta': 'Meta',
  '/ws': 'Meta',
  '/interactions': 'Rec',
  '/recommendations': 'Rec',
  '/rec': 'Rec',
};

for (const route of API_ROUTES) {
  const prefix = Object.keys(sectionByPrefix).find(p => route.path.startsWith(p));
  const section = sectionByPrefix[prefix] ?? 'Other';
  if (!sections[section]) sections[section] = [];
  sections[section].push(renderRoute(route));
}

// Read package version from root package.json
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = rootPkg.version ?? 'dev';
const date = new Date().toISOString().slice(0, 10);

const mdLines = [
  `# Boomerang Platform Worker — REST API`,
  '',
  `_v${version} · generated ${date}_`,
  '',
  'This document is generated from `platform-worker/src/apiRoutes.ts`. Edit that file to update it.',
  '',
  '## Base URL',
  '',
  'Configured via `wrangler.jsonc`. All routes are CORS-enabled for configured origins.',
  '',
  '## Authentication',
  '',
  'Routes marked **Auth: Bearer token** require an `Authorization: Bearer <token>` header',
  'where `<token>` is the room token issued by `POST /sync/room`.',
  '',
  '## Rate Limiting',
  '',
  'Per-IP rate limits are enforced via an in-isolate sliding window.',
  'Exceeding a limit returns **429 Too Many Requests** with a `Retry-After` header.',
  '',
  '---',
  '',
];

for (const [heading, routes] of Object.entries(sections)) {
  if (routes.length === 0) continue;
  mdLines.push(`## ${heading}`, '', ...routes);
}

const mdContent = mdLines.join('\n');

// ── Inline Markdown-to-HTML renderer ──────────────────────────────────────
// Handles the specific patterns used in the REST API docs.

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderInline(text) {
  return escapeHtml(text)
    // **bold**
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // `code`
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // _italic_
    .replace(/_(.+?)_/g, '<em>$1</em>');
}

function markdownToHtml(md) {
  const rawLines = md.split('\n');
  const html = [];
  let i = 0;
  let inParagraph = false;

  function closeParagraph() {
    if (inParagraph) {
      html.push('</p>');
      inParagraph = false;
    }
  }

  while (i < rawLines.length) {
    const line = rawLines[i];

    // H1
    if (/^# /.test(line)) {
      closeParagraph();
      html.push(`<h1>${renderInline(line.slice(2))}</h1>`);
      i++;
      continue;
    }
    // H2
    if (/^## /.test(line)) {
      closeParagraph();
      html.push(`<h2>${renderInline(line.slice(3))}</h2>`);
      i++;
      continue;
    }
    // H3
    if (/^### /.test(line)) {
      closeParagraph();
      html.push(`<h3>${renderInline(line.slice(4))}</h3>`);
      i++;
      continue;
    }
    // Horizontal rule
    if (/^---\s*$/.test(line)) {
      closeParagraph();
      html.push('<hr>');
      i++;
      continue;
    }
    // Blockquote
    if (/^> /.test(line)) {
      closeParagraph();
      html.push(`<blockquote>${renderInline(line.slice(2))}</blockquote>`);
      i++;
      continue;
    }
    // Blank line — close paragraph
    if (line.trim() === '') {
      closeParagraph();
      i++;
      continue;
    }
    // Regular text — accumulate into paragraph
    if (!inParagraph) {
      html.push('<p>');
      inParagraph = true;
    } else {
      html[html.length - 1] += '<br>';
    }
    html[html.length - 1] += renderInline(line);
    i++;
  }

  closeParagraph();
  return html.join('\n');
}

// ── Shared CSS ─────────────────────────────────────────────────────────────

const sharedCss = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 2rem 1.5rem;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    font-size: 1rem;
    line-height: 1.65;
    color: #1a1a1a;
    background: #f9f9f9;
  }
  .container {
    max-width: 860px;
    margin: 0 auto;
    background: #fff;
    padding: 2.5rem 3rem;
    border-radius: 8px;
    box-shadow: 0 1px 4px rgba(0,0,0,0.08);
  }
  h1 { font-size: 1.9rem; margin-top: 0; color: #111; }
  h2 { font-size: 1.4rem; margin-top: 2rem; color: #222; border-bottom: 1px solid #e5e5e5; padding-bottom: 0.25rem; }
  h3 { font-size: 1.05rem; margin-top: 1.5rem; color: #333; }
  code {
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    font-size: 0.875em;
    background: #f3f4f6;
    padding: 0.15em 0.35em;
    border-radius: 3px;
  }
  pre {
    background: #f3f4f6;
    padding: 1rem;
    border-radius: 5px;
    overflow-x: auto;
  }
  pre code { background: none; padding: 0; }
  blockquote {
    margin: 1rem 0;
    padding: 0.6rem 1rem;
    border-left: 3px solid #d1d5db;
    color: #555;
    background: #f8f8f8;
    border-radius: 0 4px 4px 0;
  }
  hr { border: none; border-top: 1px solid #e5e5e5; margin: 2rem 0; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .meta { color: #6b7280; font-size: 0.9rem; margin-top: 0.25rem; }
`.trim();

// ── Build index.html ───────────────────────────────────────────────────────

const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Boomerang API Docs</title>
  <style>
${sharedCss}
    .links { list-style: none; padding: 0; margin: 1.5rem 0 0; }
    .links li { margin: 0.75rem 0; }
    .links a {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 1.05rem;
      font-weight: 500;
    }
    .links .desc { font-size: 0.875rem; color: #6b7280; margin-left: 0.25rem; font-weight: 400; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Boomerang API Documentation</h1>
    <p class="meta">v${version} &mdash; generated ${date}</p>
    <p>Browse the available documentation:</p>
    <ul class="links">
      <li>
        <a href="platform-worker/">platform-worker</a>
        <span class="desc">TypeDoc — Cloudflare Worker internals</span>
      </li>
      <li>
        <a href="news-feed/">news-feed</a>
        <span class="desc">TypeDoc — React app internals</span>
      </li>
      <li>
        <a href="api-rest.html">REST API Reference</a>
        <span class="desc">Platform Worker HTTP endpoints</span>
      </li>
    </ul>
  </div>
</body>
</html>
`;

// ── Build api-rest.html ────────────────────────────────────────────────────

const restBodyHtml = markdownToHtml(mdContent);

const restHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Boomerang REST API Reference</title>
  <style>
${sharedCss}
    .back { margin-bottom: 1.5rem; font-size: 0.9rem; }
  </style>
</head>
<body>
  <div class="container">
    <p class="back"><a href="index.html">&larr; Back to docs index</a></p>
${restBodyHtml}
  </div>
</body>
</html>
`;

// ── Write all output files ─────────────────────────────────────────────────

const apiDir = join(root, 'docs/api');
mkdirSync(apiDir, { recursive: true });

const mdPath   = join(apiDir, 'api-rest.md');
const htmlPath = join(apiDir, 'api-rest.html');
const idxPath  = join(apiDir, 'index.html');

writeFileSync(mdPath,   mdContent, 'utf8');
writeFileSync(htmlPath, restHtml,  'utf8');
writeFileSync(idxPath,  indexHtml, 'utf8');

console.info(`wrote ${mdPath}   (${Buffer.byteLength(mdContent)} bytes)`);
console.info(`wrote ${htmlPath} (${Buffer.byteLength(restHtml)} bytes)`);
console.info(`wrote ${idxPath}  (${Buffer.byteLength(indexHtml)} bytes)`);
