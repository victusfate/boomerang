# Pause Handoff

**When:** 2026-06-23  
**Branch:** `claude/capture-connector`  
**Based on:** `origin/main` @ `3fd3f64`

---

## Goal

Complete the Capture Connector feature — a bookmarklet-driven browser-to-app
article capture pipeline.

---

## Active Artifacts

```
docs/capture-connector/
  design.md     — complete
  prd.md        — complete
  plan.md       — complete
  tdd-log.md    — all 8 slices done
```

No files are mid-edit. Working tree is clean and local integration/smoke tests are fully verified and 100% green.

---

## Done This Session

- Verified local node tests (62/62 passed) and live integration/smoke tests (7/7 passed) against wrangler local server
- Applied `darker-text` custom theme to the global settings (`~/.pi/agent/settings.json` / `themes/darker-text.json`) to fix readability issues with gray-on-cyan text
- Ready for PR creation

---

## Next Steps

**If creating a PR:**
```
/create-pr
```

**For production deploy (before merging):**
1. `cd platform-worker && npx wrangler kv namespace create CAPTURE_TOKENS`
2. Replace `"REPLACE_ME"` in `platform-worker/wrangler.jsonc` with the real namespace ID
3. If github destination wanted: `npx wrangler secret put GITHUB_PAT`
4. `npx wrangler deploy`

**Pre-existing issues still open (not caused by this feature):**
- `news-feed/src/App.tsx` — `SyncStatus` and `SyncIndicatorState` imported but unused
  (both on `origin/main` before any capture work)
- `news-feed` node tests `syncWorker` + `metaWorker` fail due to `.js` import of
  `http-status` (pre-existing, not in capture test suite)

---

## Open Questions

- None blocking merge. Production KV namespace ID is the only deploy-time gap.

---

## How to Resume

From any device: `/resume`  
From this machine (full history): `claude -c`
