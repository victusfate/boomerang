#!/usr/bin/env node
// Live RSS feed health + paywall check
// Usage: node scripts/poll-rss-feeds.mjs
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const sources = JSON.parse(readFileSync(resolve(__dir, '../shared/rss-sources.json'), 'utf-8'));

// ── Additional candidates to probe ──────────────────────────────────────────
const CANDIDATES = [
  { id: 'phoronix',    name: 'Phoronix',            feedUrl: 'https://www.phoronix.com/phoronix-rss.php',                              category: 'technology' },
  { id: 'bleeping',    name: 'BleepingComputer',     feedUrl: 'https://www.bleepingcomputer.com/feed/',                                 category: 'technology' },
  { id: 'reuters2',    name: 'Reuters Agency',       feedUrl: 'https://www.reutersagency.com/feed/?best-regions=world&post_type=best',  category: 'world' },
  { id: 'convo-tech',  name: 'The Conversation',     feedUrl: 'https://theconversation.com/us/technology/articles.atom',               category: 'technology' },
  { id: 'hf-blog',     name: 'HuggingFace Blog',     feedUrl: 'https://huggingface.co/blog/feed.xml',                                  category: 'technology' },
  { id: 'google-res',  name: 'Google Research Blog', feedUrl: 'https://feeds.feedburner.com/blogspot/gwebse',                          category: 'technology' },
  { id: 'nasa2',       name: 'NASA News Releases',   feedUrl: 'https://www.nasa.gov/news-release/feed/',                               category: 'science'    },
];

const TIMEOUT_MS = 12_000;
const CONCURRENCY = 6;

const PAYWALL_RE = [
  /subscribe to (continue|read|access)/i,
  /you'?ve reached (your|the) (monthly )?limit/i,
  /this content is (only )?available (to|for) (subscribers|members|premium)/i,
  /subscription required/i,
  /please (log[ -]?in|sign[ -]?in) to (read|access|view)/i,
  /get unlimited access/i,
  /unlock (this|full) (story|article|content)/i,
  /class="paywall/i,
  /id="paywall/i,
  /data-paywall/i,
];

async function fetchWithTimeout(url, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...headers,
      },
    });
    clearTimeout(t);
    return res;
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

function extractItems(xml) {
  // Handles both RSS <item> and Atom <entry>
  const re = /<(item|entry)[\s>]([\s\S]*?)<\/(item|entry)>/g;
  const items = [];
  let m;
  while ((m = re.exec(xml)) !== null && items.length < 3) {
    const block = m[2];
    // link: <link>url</link> or <link href="url"/> or <guid>url</guid>
    const linkM =
      block.match(/<link[^>]*href=["']([^"']+)["']/) ||
      block.match(/<link[^>]*>\s*([^<\s]+)\s*<\/link>/) ||
      block.match(/<guid[^>]*>\s*(https?:\/\/[^<\s]+)\s*<\/guid>/);
    // description/summary/content — strip CDATA and tags
    const descM = block.match(
      /<(?:description|summary|content(?::[^>]+)?)(?:\s[^>]*)?>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:description|summary|content(?::[^>]+)?)>/
    );
    const rawDesc = descM ? descM[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    items.push({
      link: linkM ? linkM[1].trim() : null,
      descLen: rawDesc.length,
    });
  }
  return items;
}

async function checkSource(src) {
  const r = {
    id: src.id,
    name: src.name,
    isCandidate: src._candidate ?? false,
    feedStatus: '-',
    items: 0,
    avgDesc: 0,
    articleStatus: '-',
    paywallHit: false,
    verdict: 'UNKNOWN',
    notes: [],
  };

  // 1. RSS feed
  let xml = null;
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
    r.notes.push(e.message?.slice(0, 60) ?? 'fetch error');
    return r;
  }

  const items = extractItems(xml);
  r.items = items.length;
  r.avgDesc = items.length ? Math.round(items.reduce((s, i) => s + i.descLen, 0) / items.length) : 0;

  if (items.length === 0) {
    r.verdict = 'WARN';
    r.notes.push('feed returned 0 items');
    return r;
  }

  // 2. First article
  const articleUrl = items.find(i => i.link?.startsWith('http'))?.link;
  if (articleUrl) {
    try {
      const res = await fetchWithTimeout(articleUrl);
      r.articleStatus = res.status;
      if (res.ok) {
        const html = await res.text();
        const hit = PAYWALL_RE.find(p => p.test(html));
        if (hit) {
          r.paywallHit = true;
          r.notes.push(`paywall keyword: ${hit.source.slice(0, 40)}`);
        }
        // Additional signal: very short article body likely means blocked/redirected to subscribe page
        const bodyText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (bodyText.length < 500 && !r.paywallHit) {
          r.notes.push(`article body thin (${bodyText.length} chars)`);
        }
      } else {
        r.notes.push(`article HTTP ${res.status}`);
      }
    } catch (e) {
      r.articleStatus = 'ERR';
      r.notes.push(`article: ${e.message?.slice(0, 50) ?? 'error'}`);
    }
  } else {
    r.notes.push('no article URL found in feed');
  }

  // Verdict
  if (r.paywallHit) {
    r.verdict = 'PAYWALL';
  } else if (r.feedStatus === 200 && r.items > 0) {
    if (r.avgDesc < 40) {
      r.verdict = 'WARN';
      r.notes.push('very short feed descriptions');
    } else {
      r.verdict = 'OK';
    }
  } else {
    r.verdict = 'FAIL';
  }

  return r;
}

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

// Build work list: enabled non-YT sources + candidates
const toCheck = [
  ...sources
    .filter(s => !s.feedUrl.includes('youtube.com'))
    .map(s => ({ ...s, _candidate: false })),
  ...CANDIDATES.map(s => ({ ...s, enabled: true, priority: 2, _candidate: true })),
];

process.stderr.write(`\nPolling ${toCheck.length} feeds (concurrency ${CONCURRENCY})…\n`);
const tasks = toCheck.map(src => async () => {
  process.stderr.write(`  ${src.id.padEnd(14)} ${src.name}\n`);
  return checkSource(src);
});

const results = await pool(tasks, CONCURRENCY);

// Sort: worst first
const order = { PAYWALL: 0, FAIL: 1, WARN: 2, UNKNOWN: 3, OK: 4 };
results.sort((a, b) => (order[a.verdict] ?? 5) - (order[b.verdict] ?? 5));

const icon = { OK: '✓', WARN: '⚠', FAIL: '✗', PAYWALL: '🔒', UNKNOWN: '?' };
const C = { reset: '\x1b[0m', red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', dim: '\x1b[2m' };
const verdictColor = { OK: C.green, WARN: C.yellow, FAIL: C.red, PAYWALL: C.red, UNKNOWN: C.dim };

const W = [14, 22, 6, 6, 8, 8, 10];
const hdr = ['ID', 'NAME', 'FEED', 'ITEMS', 'AVG_DESC', 'ARTICLE', 'VERDICT'];
const sep = '─'.repeat(W.reduce((a, b) => a + b, 0) + 30);

console.log('\n' + sep);
console.log(hdr.map((h, i) => h.padEnd(W[i])).join('  ') + '  NOTES');
console.log(sep);

const counts = { OK: 0, WARN: 0, FAIL: 0, PAYWALL: 0 };
for (const r of results) {
  const col = verdictColor[r.verdict] ?? '';
  const tag = r.isCandidate ? ' [NEW]' : '';
  const v = `${icon[r.verdict] ?? '?'} ${r.verdict}`;
  console.log(
    r.id.padEnd(W[0]) + '  ' +
    (r.name + tag).padEnd(W[1]) + '  ' +
    String(r.feedStatus).padEnd(W[2]) + '  ' +
    String(r.items).padEnd(W[3]) + '  ' +
    String(r.avgDesc).padEnd(W[4]) + '  ' +
    String(r.articleStatus).padEnd(W[5]) + '  ' +
    col + v.padEnd(W[6]) + C.reset + '  ' +
    (r.notes.join('; ') || '')
  );
  if (counts[r.verdict] !== undefined) counts[r.verdict]++;
}

console.log(sep);
console.log(
  `\nResult: ${C.green}${counts.OK} OK${C.reset}  ` +
  `${C.yellow}${counts.WARN} WARN${C.reset}  ` +
  `${C.red}${counts.FAIL} FAIL  ${counts.PAYWALL} PAYWALL${C.reset}\n`
);
