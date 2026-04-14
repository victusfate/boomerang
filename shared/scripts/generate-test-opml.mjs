import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const jsonPath = path.join(__dirname, '..', 'test-custom-feeds-100.json');
const outPath = path.join(__dirname, '..', 'test-custom-feeds-100.opml');

const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

const lines = data.map(
  s =>
    `      <outline type="rss" text="${escapeXml(s.name)}" title="${escapeXml(s.name)}" xmlUrl="${escapeXml(s.feedUrl)}" boomerangCustom="true"/>`,
);

const body = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<opml version="2.0">',
  '  <head>',
  '    <title>Boomerang test — 100 custom feeds</title>',
  `    <dateCreated>${new Date().toUTCString()}</dateCreated>`,
  '  </head>',
  '  <body>',
  '    <outline text="Custom" title="Custom">',
  ...lines,
  '    </outline>',
  '  </body>',
  '</opml>',
].join('\n');

fs.writeFileSync(outPath, body, 'utf8');
console.log('Wrote', outPath);
