#!/usr/bin/env node
// Generates docs/api-rest.md from platform-worker/src/apiRoutes.ts.
// Run via: node --experimental-strip-types scripts/gen-api-docs.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const { API_ROUTES } = await import(
  join(root, 'platform-worker/src/apiRoutes.ts')
);

// ── Renderers ──────────────────────────────────────────────────────────────

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
  Health: [],
  RSS:    [],
  Sync:   [],
  Meta:   [],
  Rec:    [],
};

const sectionByPrefix = {
  '/health':         'Health',
  '/bundle':         'RSS',
  '/og-image':       'RSS',
  '/image':          'RSS',
  '/sync':           'Sync',
  '/meta':           'Meta',
  '/ws':             'Meta',
  '/interactions':   'Rec',
  '/recommendations':'Rec',
  '/rec':            'Rec',
};

for (const route of API_ROUTES) {
  const prefix = Object.keys(sectionByPrefix).find(p => route.path.startsWith(p));
  const section = sectionByPrefix[prefix] ?? 'Other';
  if (!sections[section]) sections[section] = [];
  sections[section].push(renderRoute(route));
}

const ISO_DATE_PREFIX_LENGTH = 10; // "YYYY-MM-DD" is the first 10 chars of an ISO timestamp

const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = rootPkg.version ?? 'dev';
const date = new Date().toISOString().slice(0, ISO_DATE_PREFIX_LENGTH);

const lines = [
  `# Boomerang Platform Worker — REST API`,
  '',
  `_v${version} · generated ${date}_`,
  '',
  '<!-- Generated from `platform-worker/src/apiRoutes.ts` — do not edit by hand. -->',
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
  lines.push(`## ${heading}`, '', ...routes);
}

const content = lines.join('\n');
const outPath = join(root, 'docs/api-rest.md');
mkdirSync(join(root, 'docs'), { recursive: true });
writeFileSync(outPath, content, 'utf8');
console.info(`wrote ${outPath} (${Buffer.byteLength(content)} bytes)`);
