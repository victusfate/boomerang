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
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';

const __dir     = dirname(fileURLToPath(import.meta.url));
const SOURCES   = resolve(__dir, '../shared/rss-sources.json');
const RESULTS   = resolve(__dir, '../shared/rss-sources.results.json');
const PORT      = 3456;

const CATEGORIES = ['technology', 'world', 'science', 'environment', 'sports', 'entertainment', 'general'];

// ── HTML ──────────────────────────────────────────────────────────────────────
const HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RSS Source Editor</title>
<style>
:root{--bg:#f0f2f5;--surface:#fff;--border:#d1d5db;--text:#111827;--muted:#6b7280;
--green:#16a34a;--yellow:#d97706;--red:#dc2626;--blue:#2563eb;
--green-bg:#dcfce7;--yellow-bg:#fef3c7;--red-bg:#fee2e2;--blue-bg:#dbeafe;}
*{box-sizing:border-box;margin:0;padding:0}
body{font:13px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--text)}

/* ── header ── */
header{background:var(--surface);border-bottom:1px solid var(--border);
padding:10px 18px;display:flex;align-items:center;gap:12px;
position:sticky;top:0;z-index:50;box-shadow:0 1px 3px rgba(0,0,0,.08)}
header h1{font-size:15px;font-weight:700;flex:1}
.stat{font-size:12px;color:var(--muted);white-space:nowrap}
.stat b{color:var(--text)}

/* ── buttons ── */
button{border:1px solid var(--border);background:var(--surface);padding:5px 13px;
border-radius:5px;cursor:pointer;font-size:12px;font-weight:500;transition:background .12s,opacity .12s}
button:hover{background:var(--bg)}
button:disabled{opacity:.45;cursor:default}
.btn-primary{background:var(--blue);color:#fff;border-color:var(--blue)}
.btn-primary:hover{background:#1d4ed8}
.btn-danger{background:var(--red);color:#fff;border-color:var(--red)}
.btn-success{background:var(--green);color:#fff;border-color:var(--green)}
.btn-sm{padding:3px 9px;font-size:11px}

/* ── toolbar ── */
.toolbar{display:flex;gap:8px;align-items:center;padding:8px 18px;
background:var(--surface);border-bottom:1px solid var(--border);flex-wrap:wrap}
.toolbar select,.toolbar input[type=text]{border:1px solid var(--border);padding:5px 9px;
border-radius:5px;font-size:12px;background:var(--surface)}
.toolbar input[type=text]{width:180px}
.spacer{flex:1}

/* ── main ── */
main{padding:16px 18px;max-width:1400px}

/* ── table ── */
.table-wrap{overflow-x:auto;border-radius:7px;box-shadow:0 1px 4px rgba(0,0,0,.1)}
table{width:100%;border-collapse:collapse;background:var(--surface)}
th{background:#f9fafb;font-weight:600;font-size:11px;text-transform:uppercase;
letter-spacing:.4px;padding:7px 10px;text-align:left;border-bottom:1px solid var(--border);
white-space:nowrap}
td{padding:7px 10px;border-bottom:1px solid #f3f4f6;vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:#fafafa}

/* row tints */
tr.row-WARN td{background:#fffbeb}
tr.row-FAIL td,tr.row-PAYWALL td{background:#fff5f5}
tr.cut td{background:#fce7e7!important;opacity:.6}
tr.cut .src-name{text-decoration:line-through;color:var(--muted)}

/* ── verdict badge ── */
.badge{display:inline-block;padding:2px 7px;border-radius:10px;
font-size:10px;font-weight:700;white-space:nowrap;letter-spacing:.2px}
.v-OK{background:var(--green-bg);color:var(--green)}
.v-WARN{background:var(--yellow-bg);color:var(--yellow)}
.v-FAIL{background:var(--red-bg);color:var(--red)}
.v-PAYWALL{background:var(--red-bg);color:var(--red)}
.v-UNKNOWN{background:#f3f4f6;color:var(--muted)}

/* ── cells ── */
.cell-id{font-family:monospace;font-size:11px;color:var(--muted)}
.cell-url{font-family:monospace;font-size:11px;color:var(--muted);max-width:240px;
overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cell-notes{font-size:11px;color:var(--muted);max-width:200px}
.cell-actions{display:flex;gap:5px;white-space:nowrap}

/* enabled pill */
.pill{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;
font-weight:600;cursor:pointer;border:1px solid;user-select:none}
.pill-on{background:var(--green-bg);color:var(--green);border-color:#a7f3d0}
.pill-off{background:#f3f4f6;color:var(--muted);border-color:#e5e7eb}

/* ── poll panel ── */
#poll-panel{background:#1a1a2e;border-radius:7px;margin-bottom:14px;overflow:hidden;display:none}
#poll-panel.visible{display:block}
.poll-hd{display:flex;align-items:center;justify-content:space-between;
padding:7px 13px;background:#16213e;cursor:pointer;color:#a0aec0;font-size:12px;font-weight:600}
.poll-hd:hover{background:#1a2a4a}
#poll-out{padding:10px 13px;font-family:monospace;font-size:11px;line-height:1.7;
max-height:260px;overflow-y:auto;color:#c9d1d9;white-space:pre-wrap;word-break:break-all}

/* ── add form ── */
#add-form{background:var(--surface);border:1px solid var(--border);border-radius:7px;
padding:14px 16px;margin-bottom:14px;display:none}
#add-form.visible{display:block}
#add-form h3{font-size:13px;font-weight:700;margin-bottom:10px}
.form-row{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px;align-items:flex-end}
.fg{display:flex;flex-direction:column;gap:3px}
.fg label{font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase}
.fg input,.fg select{border:1px solid var(--border);padding:5px 9px;border-radius:5px;font-size:12px}
.fg.wide{flex:1;min-width:160px}
.fg.url-field{flex:2;min-width:220px}

/* ── modal ── */
.overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);
z-index:200;align-items:center;justify-content:center}
.overlay.open{display:flex}
.modal{background:var(--surface);border-radius:10px;padding:22px;width:540px;
max-width:95vw;box-shadow:0 16px 40px rgba(0,0,0,.3)}
.modal h2{font-size:15px;font-weight:700;margin-bottom:14px}
.modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}

/* save bar */
#save-bar{display:none;position:fixed;bottom:18px;right:20px;z-index:100;
background:var(--surface);border:1px solid var(--border);border-radius:8px;
padding:10px 16px;box-shadow:0 4px 16px rgba(0,0,0,.15);display:flex;
align-items:center;gap:12px;font-size:13px}
#save-bar.visible{display:flex}
</style>
</head>
<body>

<header>
  <h1>RSS Source Editor</h1>
  <span class="stat" id="stat-total"></span>
  <span class="stat" id="stat-cut"></span>
  <button id="btn-run-poll">▶ Run Poll</button>
  <button id="btn-toggle-add">+ Add Source</button>
  <button class="btn-primary" id="btn-save">Save to rss-sources.json</button>
</header>

<div class="toolbar">
  <label style="font-size:12px;color:var(--muted)">Category:</label>
  <select id="filter-cat">
    <option value="">All</option>
    <option>technology</option><option>world</option><option>science</option>
    <option>environment</option><option>sports</option><option>entertainment</option><option>general</option>
  </select>
  <label style="font-size:12px;color:var(--muted)">Verdict:</label>
  <select id="filter-verdict">
    <option value="">All</option>
    <option>OK</option><option>WARN</option><option>FAIL</option><option>PAYWALL</option><option>UNKNOWN</option>
  </select>
  <input type="text" id="filter-search" placeholder="Search id / name / url…">
  <label style="font-size:12px;color:var(--muted)">
    <input type="checkbox" id="filter-cut"> Show cut only
  </label>
  <div class="spacer"></div>
  <span class="stat" id="stat-showing"></span>
</div>

<main>
  <div id="poll-panel">
    <div class="poll-hd" id="poll-toggle">
      <span id="poll-status">Poll output</span>
      <span>▾</span>
    </div>
    <pre id="poll-out"></pre>
  </div>

  <div id="add-form">
    <h3>Add New Source</h3>
    <div class="form-row">
      <div class="fg"><label>ID</label><input id="new-id" placeholder="e.g. wired"></div>
      <div class="fg wide"><label>Name</label><input id="new-name" placeholder="Wired"></div>
      <div class="fg url-field"><label>Feed URL</label><input id="new-url" placeholder="https://…/feed.xml"></div>
    </div>
    <div class="form-row">
      <div class="fg">
        <label>Category</label>
        <select id="new-cat">
          <option>technology</option><option>world</option><option>science</option>
          <option>environment</option><option>sports</option><option>entertainment</option><option>general</option>
        </select>
      </div>
      <div class="fg">
        <label>Priority</label>
        <select id="new-pri"><option value="1">1 — fast tier</option><option value="2" selected>2 — background</option></select>
      </div>
      <div class="fg" style="justify-content:flex-end">
        <label>Enabled</label>
        <input type="checkbox" id="new-enabled" checked style="width:18px;height:18px;margin-top:4px">
      </div>
      <div class="fg" style="justify-content:flex-end;margin-left:auto">
        <button class="btn-primary" id="btn-add-confirm" style="margin-top:auto">Add Source</button>
      </div>
    </div>
  </div>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Verdict</th>
          <th>ID</th>
          <th>Name</th>
          <th>Category</th>
          <th>Pri</th>
          <th>Enabled</th>
          <th>Feed URL</th>
          <th>Notes</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody id="source-tbody"></tbody>
    </table>
  </div>
</main>

<div id="save-bar" class="visible">
  <span id="save-info">0 changes pending</span>
  <button class="btn-primary" id="btn-save2">Save</button>
  <button id="btn-discard">Discard</button>
</div>

<!-- edit modal -->
<div class="overlay" id="edit-overlay">
  <div class="modal">
    <h2>Edit Source</h2>
    <div class="form-row">
      <div class="fg"><label>ID</label><input id="edit-id" readonly style="background:#f9fafb;color:var(--muted)"></div>
      <div class="fg wide"><label>Name</label><input id="edit-name"></div>
    </div>
    <div class="form-row">
      <div class="fg url-field" style="flex:1"><label>Feed URL</label><input id="edit-url"></div>
    </div>
    <div class="form-row">
      <div class="fg">
        <label>Category</label>
        <select id="edit-cat">
          <option>technology</option><option>world</option><option>science</option>
          <option>environment</option><option>sports</option><option>entertainment</option><option>general</option>
        </select>
      </div>
      <div class="fg">
        <label>Priority</label>
        <select id="edit-pri"><option value="1">1 — fast</option><option value="2">2 — background</option></select>
      </div>
      <div class="fg">
        <label>Enabled</label>
        <input type="checkbox" id="edit-enabled" style="width:18px;height:18px;margin-top:4px">
      </div>
    </div>
    <div class="modal-actions">
      <button id="btn-edit-cancel">Cancel</button>
      <button class="btn-primary" id="btn-edit-save">Save Changes</button>
    </div>
  </div>
</div>

<script>
// ── state ─────────────────────────────────────────────────────────────────────
let sources = [];   // full list, including added/edited
let results = {};   // id → { verdict, notes, … } from poll
let cutIds  = new Set();
let dirty   = false;

// ── fetch data ────────────────────────────────────────────────────────────────
async function load() {
  const d = await fetch('/api/data').then(r => r.json());
  sources = d.sources;
  results = d.results ?? {};
  render();
}

// ── verdict helper ────────────────────────────────────────────────────────────
function verdict(id) {
  return results[id]?.verdict ?? 'UNKNOWN';
}
function badge(v) {
  return '<span class="badge v-' + v + '">' + v + '</span>';
}

// ── render ────────────────────────────────────────────────────────────────────
function render() {
  const catF   = document.getElementById('filter-cat').value;
  const vF     = document.getElementById('filter-verdict').value;
  const search = document.getElementById('filter-search').value.toLowerCase();
  const cutOnly = document.getElementById('filter-cut').checked;

  const visible = sources.filter(s => {
    if (catF   && s.category !== catF) return false;
    if (vF     && verdict(s.id) !== vF) return false;
    if (cutOnly && !cutIds.has(s.id)) return false;
    if (search && !s.id.includes(search) && !s.name.toLowerCase().includes(search) && !s.feedUrl.toLowerCase().includes(search)) return false;
    return true;
  });

  const tbody = document.getElementById('source-tbody');
  tbody.innerHTML = visible.map(s => {
    const v   = verdict(s.id);
    const cut = cutIds.has(s.id);
    const r   = results[s.id];
    const notes = r?.notes?.join('; ') ?? '';
    return '<tr class="' + (cut ? 'cut' : 'row-' + v) + '" data-id="' + s.id + '">' +
      '<td>' + badge(v) + '</td>' +
      '<td class="cell-id">' + s.id + '</td>' +
      '<td class="src-name">' + esc(s.name) + '</td>' +
      '<td>' + s.category + '</td>' +
      '<td style="text-align:center">' + s.priority + '</td>' +
      '<td><span class="pill ' + (s.enabled ? 'pill-on' : 'pill-off') + '" data-toggle="' + s.id + '">' +
        (s.enabled ? 'on' : 'off') + '</span></td>' +
      '<td class="cell-url" title="' + esc(s.feedUrl) + '">' + esc(s.feedUrl) + '</td>' +
      '<td class="cell-notes">' + esc(notes) + '</td>' +
      '<td class="cell-actions">' +
        (cut
          ? '<button class="btn-sm btn-success" data-keep="' + s.id + '">Keep</button>'
          : '<button class="btn-sm btn-danger"  data-cut="'  + s.id + '">Cut</button>') +
        '<button class="btn-sm" data-edit="' + s.id + '">Edit</button>' +
      '</td>' +
    '</tr>';
  }).join('');

  // stats
  document.getElementById('stat-total').innerHTML   = '<b>' + sources.length + '</b> sources';
  document.getElementById('stat-cut').innerHTML     = cutIds.size ? '<b style="color:var(--red)">' + cutIds.size + ' cut</b>' : '';
  document.getElementById('stat-showing').textContent = 'Showing ' + visible.length + ' of ' + sources.length;

  // save bar
  const pending = cutIds.size + (dirty ? 1 : 0);
  document.getElementById('save-info').textContent = pending + ' change' + (pending === 1 ? '' : 's') + ' pending';
  document.getElementById('save-bar').className = (pending > 0 || dirty) ? 'visible' : '';
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── table click delegation ────────────────────────────────────────────────────
document.getElementById('source-tbody').addEventListener('click', e => {
  const cut  = e.target.dataset.cut;
  const keep = e.target.dataset.keep;
  const edit = e.target.dataset.edit;
  const tog  = e.target.dataset.toggle;
  if (cut)  { cutIds.add(cut);    dirty = true; render(); }
  if (keep) { cutIds.delete(keep); dirty = true; render(); }
  if (edit) openEdit(edit);
  if (tog)  { toggleEnabled(tog); render(); }
});

function toggleEnabled(id) {
  const s = sources.find(s => s.id === id);
  if (s) { s.enabled = !s.enabled; dirty = true; }
}

// ── add source ────────────────────────────────────────────────────────────────
document.getElementById('btn-toggle-add').addEventListener('click', () => {
  const f = document.getElementById('add-form');
  f.classList.toggle('visible');
});

document.getElementById('btn-add-confirm').addEventListener('click', () => {
  const id  = document.getElementById('new-id').value.trim();
  const name = document.getElementById('new-name').value.trim();
  const url  = document.getElementById('new-url').value.trim();
  const cat  = document.getElementById('new-cat').value;
  const pri  = Number(document.getElementById('new-pri').value);
  const en   = document.getElementById('new-enabled').checked;
  if (!id || !name || !url) { alert('ID, Name, and Feed URL are required.'); return; }
  if (sources.find(s => s.id === id)) { alert('ID "' + id + '" already exists.'); return; }
  sources.push({ id, name, feedUrl: url, category: cat, enabled: en, priority: pri });
  dirty = true;
  // clear
  ['new-id','new-name','new-url'].forEach(i => document.getElementById(i).value = '');
  document.getElementById('add-form').classList.remove('visible');
  render();
});

// ── edit modal ────────────────────────────────────────────────────────────────
function openEdit(id) {
  const s = sources.find(s => s.id === id);
  if (!s) return;
  document.getElementById('edit-id').value      = s.id;
  document.getElementById('edit-name').value    = s.name;
  document.getElementById('edit-url').value     = s.feedUrl;
  document.getElementById('edit-cat').value     = s.category;
  document.getElementById('edit-pri').value     = String(s.priority);
  document.getElementById('edit-enabled').checked = s.enabled;
  document.getElementById('edit-overlay').classList.add('open');
}

document.getElementById('btn-edit-cancel').addEventListener('click', () => {
  document.getElementById('edit-overlay').classList.remove('open');
});

document.getElementById('btn-edit-save').addEventListener('click', () => {
  const id  = document.getElementById('edit-id').value;
  const s   = sources.find(s => s.id === id);
  if (!s) return;
  s.name     = document.getElementById('edit-name').value.trim();
  s.feedUrl  = document.getElementById('edit-url').value.trim();
  s.category = document.getElementById('edit-cat').value;
  s.priority = Number(document.getElementById('edit-pri').value);
  s.enabled  = document.getElementById('edit-enabled').checked;
  dirty = true;
  document.getElementById('edit-overlay').classList.remove('open');
  render();
});

document.getElementById('edit-overlay').addEventListener('click', e => {
  if (e.target === e.currentTarget) document.getElementById('edit-overlay').classList.remove('open');
});

// ── filters ───────────────────────────────────────────────────────────────────
['filter-cat','filter-verdict','filter-search','filter-cut'].forEach(id => {
  document.getElementById(id).addEventListener('input', render);
  document.getElementById(id).addEventListener('change', render);
});

// ── save ──────────────────────────────────────────────────────────────────────
async function save() {
  const final = sources.filter(s => !cutIds.has(s.id));
  const res = await fetch('/api/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(final, null, 2),
  });
  const d = await res.json();
  if (d.ok) {
    sources = final;
    cutIds.clear();
    dirty = false;
    render();
    showToast('Saved ' + final.length + ' sources to rss-sources.json');
  } else {
    alert('Save failed: ' + d.error);
  }
}

document.getElementById('btn-save').addEventListener('click', save);
document.getElementById('btn-save2').addEventListener('click', save);
document.getElementById('btn-discard').addEventListener('click', () => {
  if (!confirm('Discard all unsaved changes?')) return;
  cutIds.clear();
  dirty = false;
  load();
});

// ── poll ──────────────────────────────────────────────────────────────────────
let pollRunning = false;

document.getElementById('btn-run-poll').addEventListener('click', () => {
  if (pollRunning) return;
  pollRunning = true;
  document.getElementById('btn-run-poll').disabled = true;
  document.getElementById('btn-run-poll').textContent = '⏳ Polling…';
  const panel = document.getElementById('poll-panel');
  const out   = document.getElementById('poll-out');
  panel.classList.add('visible');
  out.textContent = '';
  document.getElementById('poll-status').textContent = 'Poll running…';

  const es = new EventSource('/api/poll');
  es.onmessage = e => {
    const d = JSON.parse(e.data);
    if (d.type === 'out' || d.type === 'err') {
      out.textContent += stripAnsi(d.text);
      out.scrollTop = out.scrollHeight;
    }
    if (d.type === 'done') {
      es.close();
      pollRunning = false;
      document.getElementById('btn-run-poll').disabled = false;
      document.getElementById('btn-run-poll').textContent = '▶ Run Poll';
      document.getElementById('poll-status').textContent =
        d.code === 0 ? '✓ Poll complete' : '✗ Poll exited ' + d.code;
      // reload verdicts
      fetch('/api/data').then(r => r.json()).then(d => { results = d.results ?? {}; render(); });
    }
  };
  es.onerror = () => {
    es.close();
    pollRunning = false;
    document.getElementById('btn-run-poll').disabled = false;
    document.getElementById('btn-run-poll').textContent = '▶ Run Poll';
    document.getElementById('poll-status').textContent = '✗ Connection error';
  };
});

document.getElementById('poll-toggle').addEventListener('click', () => {
  const o = document.getElementById('poll-out');
  o.style.display = o.style.display === 'none' ? '' : 'none';
});

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*[mGKHFABCDJRsu]/g, '');
}

// ── toast ─────────────────────────────────────────────────────────────────────
function showToast(msg) {
  const t = document.createElement('div');
  t.textContent = msg;
  Object.assign(t.style, {
    position:'fixed',bottom:'70px',right:'20px',background:'#111',color:'#fff',
    padding:'8px 16px',borderRadius:'6px',zIndex:'999',fontSize:'13px',
    boxShadow:'0 4px 12px rgba(0,0,0,.3)',opacity:'1',transition:'opacity .4s'
  });
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 400); }, 2500);
}

// ── init ──────────────────────────────────────────────────────────────────────
load();
</script>
</body>
</html>`;

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/data') {
    const src = JSON.parse(readFileSync(SOURCES, 'utf-8'));
    const res2 = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf-8')) : null;
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/poll') {
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

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('\nRSS Source Editor');
  console.log('─────────────────────────────────');
  console.log(`  http://localhost:${PORT}/`);
  console.log('');
  console.log('  Run poll first to get verdicts:');
  console.log('    node scripts/poll-rss-feeds.mjs');
  console.log('  …or click "Run Poll" in the UI.');
  console.log('');
  console.log('  Press Ctrl+C to stop.\n');
});
