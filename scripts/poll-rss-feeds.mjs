#!/usr/bin/env node
/**
 * RSS feed health check + candidate generator
 *
 * Usage:
 *   node scripts/poll-rss-feeds.mjs
 *
 * Reads:   shared/rss-sources.json
 * Writes:  shared/rss-sources.candidate.json   (drop-in replacement, bad feeds removed)
 *
 * Verdicts
 *   OK      feed reachable, items present, article accessible, no paywall keywords
 *   WARN    feed works but descriptions are very short OR article body is thin —
 *           kept in candidate, worth a manual spot-check
 *   FAIL    feed unreachable (HTTP error / timeout / DNS) — removed from candidate
 *   PAYWALL paywall keyword found in article HTML — removed from candidate
 *
 * YouTube sources are skipped (always free) and passed through to the candidate unchanged.
 *
 * After reviewing shared/rss-sources.candidate.json run:
 *   cp shared/rss-sources.candidate.json shared/rss-sources.json
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const SOURCES_PATH   = resolve(__dir, '../shared/rss-sources.json');
const CANDIDATE_PATH = resolve(__dir, '../shared/rss-sources.candidate.json');

const sources = JSON.parse(readFileSync(SOURCES_PATH, 'utf-8'));

// ── Config ───────────────────────────────────────────────────────────────────
const TIMEOUT_MS  = 14_000;
const CONCURRENCY = 5;   // keep polite; raise to 8-10 on a fast connection

// Patterns that indicate a paywall wall in article HTML
const PAYWALL_RE = [
  /subscribe to (continue|read|access)/i,
  /you'?ve reached (your|the) (monthly |free )?limit/i,
  /this (content|article|story) is (only )?available (to|for) (subscribers?|members?|premium)/i,
  /subscription required/i,
  /please (log[ -]?in|sign[ -]?in) to (read|access|view)/i,
  /get unlimited access/i,
  /unlock (this|full) (story|article|content)/i,
  /become a (subscriber|member) to (read|access)/i,
  /already a (subscriber|member)\? (sign|log) in/i,
  /class="paywall/i,
  /id="paywall/i,
  /data-paywall/i,
  /\bpaywall-container\b/i,
];

// Signals that an article redirect landed on a subscribe/login page
const SUBSCRIBE_URL_RE = /\/(subscribe|subscription|account\/login|sign.?in|membership)(\/|\?|$)/i;

// ── Fetch helpers ─────────────────────────────────────────────────────────────
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function fetchWithTimeout(url, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', ...headers },
    });
    clearTimeout(t);
    return res;
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

// ── XML item extractor ────────────────────────────────────────────────────────
function extractItems(xml) {
  const re = /<(item|entry)[\s>]([\s\S]*?)<\/\1>/g;
  const items = [];
  let m;
  while ((m = re.exec(xml)) !== null && items.length < 3) {
    const block = m[2];
    const linkM =
      block.match(/<link[^>]*href=["']([^"']+)["']/) ||
      block.match(/<link[^>]*>\s*(https?:\/\/[^\s<]+)\s*<\/link>/) ||
      block.match(/<guid[^>]*isPermaLink="true"[^>]*>\s*(https?:\/\/[^\s<]+)\s*<\/guid>/) ||
      block.match(/<guid[^>]*>\s*(https?:\/\/[^\s<]+)\s*<\/guid>/);
    const descM = block.match(
      /<(?:description|summary|content(?::[^>]*)?)(?:\s[^>]*)?>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:description|summary|content(?::[^>]*)?)>/
    );
    const rawDesc = descM ? descM[1].replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim() : '';
    items.push({ link: linkM?.[1]?.trim() ?? null, descLen: rawDesc.length });
  }
  return items;
}

// ── Per-source check ──────────────────────────────────────────────────────────
async function checkSource(src) {
  const r = {
    id: src.id, name: src.name, enabled: src.enabled,
    feedStatus: '-', items: 0, avgDesc: 0,
    articleStatus: '-', finalUrl: null,
    paywallHit: false, verdict: 'UNKNOWN', notes: [],
  };

  // 1. Fetch RSS/Atom feed
  let xml;
  try {
    const res = await fetchWithTimeout(src.feedUrl, {
      Accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*',
    });
    r.feedStatus = res.status;
    if (!res.ok) {
      r.verdict = 'FAIL';
      r.notes.push(`feed HTTP ${res.status}`);
      return r;
    }
    xml = await res.text();
  } catch (e) {
    r.feedStatus = 'ERR';
    r.verdict = 'FAIL';
    r.notes.push(e.name === 'AbortError' ? 'feed timeout' : (e.message?.slice(0, 60) ?? 'network error'));
    return r;
  }

  const items = extractItems(xml);
  r.items = items.length;
  r.avgDesc = items.length ? Math.round(items.reduce((s, i) => s + i.descLen, 0) / items.length) : 0;

  if (items.length === 0) {
    r.verdict = 'WARN';
    r.notes.push('feed has 0 parseable items');
    return r;
  }

  // 2. Fetch first article
  const articleUrl = items.find(i => i.link?.startsWith('http'))?.link;
  if (!articleUrl) {
    r.notes.push('no article URL found in feed items');
  } else {
    try {
      const res = await fetchWithTimeout(articleUrl);
      r.articleStatus = res.status;
      r.finalUrl = res.url; // after redirects

      // Redirect to a subscribe/login page
      if (r.finalUrl && SUBSCRIBE_URL_RE.test(r.finalUrl)) {
        r.paywallHit = true;
        r.notes.push(`redirected to: ${r.finalUrl.slice(0, 80)}`);
      }

      if (!r.paywallHit && res.ok) {
        const html = await res.text();
        const hit = PAYWALL_RE.find(p => p.test(html));
        if (hit) {
          r.paywallHit = true;
          r.notes.push(`paywall keyword matched`);
        }
        const bodyText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (!r.paywallHit && bodyText.length < 400) {
          r.notes.push(`article body thin (${bodyText.length} chars) — check manually`);
        }
      } else if (!res.ok && !r.paywallHit) {
        r.notes.push(`article HTTP ${res.status}`);
      }
    } catch (e) {
      r.articleStatus = 'ERR';
      r.notes.push(`article: ${e.name === 'AbortError' ? 'timeout' : (e.message?.slice(0, 50) ?? 'error')}`);
    }
  }

  // 3. Verdict
  if (r.paywallHit) {
    r.verdict = 'PAYWALL';
  } else if (r.feedStatus === 200 && r.items > 0) {
    const isWarn = r.avgDesc < 40 || r.notes.some(n => n.includes('thin') || n.includes('timeout'));
    r.verdict = isWarn ? 'WARN' : 'OK';
  } else {
    r.verdict = 'FAIL';
  }

  return r;
}

// ── Concurrency pool ──────────────────────────────────────────────────────────
async function pool(tasks, limit) {
  const results = new Array(tasks.length);
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]();
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────
const ytSources   = sources.filter(s => s.feedUrl.includes('youtube.com'));
const rssToCheck  = sources.filter(s => !s.feedUrl.includes('youtube.com'));

process.stderr.write(`\nPolling ${rssToCheck.length} RSS/Atom feeds (${ytSources.length} YouTube sources auto-pass)…\n\n`);

const tasks = rssToCheck.map(src => async () => {
  const label = `[${src.enabled ? 'on ' : 'off'}] ${src.id.padEnd(14)} ${src.name}`;
  process.stderr.write(`  ${label}\n`);
  return checkSource(src);
});

const results = await pool(tasks, CONCURRENCY);

// ── Report ────────────────────────────────────────────────────────────────────
const order = { PAYWALL: 0, FAIL: 1, WARN: 2, OK: 3, UNKNOWN: 4 };
const sorted = [...results].sort((a, b) => (order[a.verdict] ?? 5) - (order[b.verdict] ?? 5));

const C = { reset: '\x1b[0m', red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', dim: '\x1b[2m', bold: '\x1b[1m' };
const verdictColor = { OK: C.green, WARN: C.yellow, FAIL: C.red, PAYWALL: C.red + C.bold, UNKNOWN: C.dim };
const icon = { OK: '✓', WARN: '⚠', FAIL: '✗', PAYWALL: '🔒', UNKNOWN: '?' };

const SEP = '─'.repeat(108);
console.log('\n' + SEP);
console.log('EN  ID              NAME                   FEED  ITEMS  AVG_DESC  ARTICLE  VERDICT     NOTES');
console.log(SEP);

let counts = { OK: 0, WARN: 0, FAIL: 0, PAYWALL: 0 };
for (const r of sorted) {
  const col = verdictColor[r.verdict] ?? '';
  const v = `${icon[r.verdict] ?? '?'} ${r.verdict}`;
  const en = r.enabled ? ' ✓' : ' -';
  console.log(
    en.padEnd(4) +
    r.id.padEnd(16) +
    r.name.padEnd(23) +
    String(r.feedStatus).padEnd(6) +
    String(r.items).padEnd(7) +
    String(r.avgDesc).padEnd(10) +
    String(r.articleStatus).padEnd(9) +
    col + v.padEnd(12) + C.reset +
    (r.notes.join('; ') || '')
  );
  if (counts[r.verdict] !== undefined) counts[r.verdict]++;
}

// YouTube summary line
console.log(
  ' -  ' + '(YouTube × ' + ytSources.length + ')'.padEnd(15) +
  ''.padEnd(23) + C.dim + '—     —      —         —        ✓ AUTO-PASS' + C.reset
);

console.log(SEP);
console.log(`\n  ${C.green}${counts.OK} OK${C.reset}   ${C.yellow}${counts.WARN} WARN (kept, check manually)${C.reset}   ${C.red}${counts.FAIL} FAIL   ${counts.PAYWALL} PAYWALL${C.reset}\n`);

// ── Candidate JSON ────────────────────────────────────────────────────────────
const cutIds = new Set(
  results.filter(r => r.verdict === 'FAIL' || r.verdict === 'PAYWALL').map(r => r.id)
);
const warnIds = new Set(results.filter(r => r.verdict === 'WARN').map(r => r.id));

const cut   = results.filter(r => cutIds.has(r.id));
const warned = results.filter(r => warnIds.has(r.id));

if (cut.length > 0) {
  console.log(`${C.red}Removed from candidate (FAIL / PAYWALL):${C.reset}`);
  for (const r of cut) console.log(`  ✗ ${r.id.padEnd(16)} ${r.name}  — ${r.notes.join('; ')}`);
  console.log();
}
if (warned.length > 0) {
  console.log(`${C.yellow}Kept in candidate but flagged (WARN — review manually):${C.reset}`);
  for (const r of warned) console.log(`  ⚠ ${r.id.padEnd(16)} ${r.name}  — ${r.notes.join('; ')}`);
  console.log();
}

const candidate = sources.filter(s => !cutIds.has(s.id));
writeFileSync(CANDIDATE_PATH, JSON.stringify(candidate, null, 2) + '\n');

console.log(`${C.bold}Candidate written → shared/rss-sources.candidate.json${C.reset}`);
console.log(`  ${sources.length} sources in  →  ${candidate.length} sources out  (${cut.length} removed)\n`);
console.log('Review the candidate, then replace:');
console.log('  cp shared/rss-sources.candidate.json shared/rss-sources.json\n');
