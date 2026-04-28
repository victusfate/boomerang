# Updated sync — Fireproof `connect` (multi-browser)

**Feature slug:** `ai-topic-labels` (extends existing work; replaces URL-hash blob sync with ledger sync)  
**Branch:** `claude/ai-topic-labels` (or follow-on branch from main after merge)  
**Date:** 2026-04-28

## Why this doc

The app currently ships **one-way manual sync**: prefs, saved articles, AI tags, and label hits are JSON-serialized, base64url-encoded, and pasted as `#sync=…` in the URL (`news-feed/src/services/syncShare.ts`, consumed once on startup in `useFeed.ts`). That works for a single “copy state to another browser” gesture but:

- Does not **stay in sync** as either side changes.
- Hits **URL length limits** as saved data grows.
- Is **orthogonal** to [Fireproof Sharing and Sync](https://use-fireproof.com/docs/connect/) — we use `useFireproof` locally only.

The [ai-topic-labels PRD](./prd.md) already calls for *“Fireproof cloud sync … same Fireproof DB”* and a **QR pairing flow**. This document is the implementation plan to fulfill that with **real connector-based sync**, not the hash blob.

## Goal

**Multiple browsers (and eventually mobile) share one logical `boomerang-news` ledger** with continuous replication: labels, label hits, article tags, prefs, and imported saves converge via Fireproof’s sync layer instead of ad-hoc merges from a pasted hash.

## Non-goals (for first ship)

- Full user accounts / email login unless required by the chosen connector.
- Replacing the RSS worker or feed-cache cold-start behaviour.
- Two-way conflict UI beyond what the connector + CRDT semantics already provide (surface failures in logs/UI only at first).

## Connector choice (decision record)

Fireproof documents **PartyKit**, **IPFS** (web3.storage / UCAN), and **S3** adapters ([Sharing and Sync](https://use-fireproof.com/docs/connect/)).

| Option | Fits GitHub Pages static PWA | Notes |
|--------|------------------------------|--------|
| **PartyKit** | Strong — separate realtime party host | `connect.partykit(ledger, host)`; needs `PUBLIC_PARTYKIT_HOST` (or equivalent) at build time and a small PartyKit deploy. |
| **IPFS / web3.storage** | Possible | Authorization UX (`authorize(email)`, device pairing); good for “same email on two devices” but heavier onboarding. |
| **S3** | Possible if you add backend creds | Usually not ideal for a purely static front-end without a token exchange server. |

**Recommendation for Boomerang:** Prefer **PartyKit** for a straightforward “connect to party = sync” story with minimal user ceremony, *unless* product requirements explicitly want email-based device linking (then evaluate IPFS path in a follow-up).

**Open decision:** Confirm PartyKit limits, cost, and whether the existing `qrcode` flow becomes “join this party URL” vs “scan invite CID” depending on connector.

## Current code touchpoints

- `news-feed/src/hooks/useFeed.ts` — `useFireproof('boomerang-news')`, mount load, `consumeSyncHash`, `buildSyncShareUrl` export.
- `news-feed/src/services/syncShare.ts` — payload v1, merge helpers, hash parse/build.
- `news-feed/src/App.tsx` / Settings — `syncShareUrl`, QR for link.

## High-level architecture after migration

1. **Initialize ledger** with the same database name (`boomerang-news`) and attach **one** `connect.*` session per app instance.
2. **Replication** handles document propagation; reduce or remove custom `mergePrefs` / `mergeArticleTags` for *cross-device* import (keep merges only if we support offline-first import fallbacks).
3. **Settings UX**
   - **Connect / disconnected** indicator and last-sync hint (even if rough).
   - Replace or supplement **“copy sync link”** with **pairing** appropriate to connector (e.g. PartyKit room id or share link from Fireproof’s sharing APIs if used).
4. **Environment**
   - New build-time env vars (e.g. PartyKit host), document in `AGENTS.md` / README for CI (GitHub Actions vars).
5. **Deprecation of `#sync=`**
   - **Phase A:** Implement connect; keep hash import as fallback for one major version or behind a “Legacy import” control.
   - **Phase B:** Remove `syncShare.ts` hash build path and `consumeSyncHash` if telemetry/manual testing show no need.

## Vertical slices (tracer bullets)

Each slice should be end-to-end: **dependency + env → `useFeed` wiring → minimal UI → manual test** (add `*.node.test.ts` only where logic is extractable without a real connector).

| Slice | Outcome |
|-------|---------|
| **S1 — Spike** | Add chosen connector package; smallest `connect.*(ledger, …)` proof in dev; document required env and deploy steps in this folder. |
| **S2 — Wire `useFeed`** | Single connection lifecycle (mount/connect, teardown on strict mode if needed); ensure no double-connect; preserve existing Fireproof doc IDs (`user-prefs`, `feed-cache`, `ai-classifications`, etc.). |
| **S3 — Settings UX** | Connection status + instructions; QR/link updated for pairing semantics. |
| **S4 — Legacy hash** | Either gated import only, or automatic import once then `replaceState` as today; log `[Sync]` deprecation. |
| **S5 — CI & docs** | GitHub Actions / repo variables; `AGENTS.md` tech stack row for sync; trim misleading “Worker-only” phrasing if PartyKit host is required. |
| **S6 — Hardening** | Error surfaces (auth failed, offline), limit doc size concerns, confirm mobile behaviour; update [tdd-log](./tdd-log.md) per repo convention. |

## Risks and limitations (from Fireproof docs)

- **Safari multi-device authorization** called out as a known limitation on the connect page — verify behaviour for iOS targets.
- **Handshake latency** — polling-based today; acceptable for news app but set user expectations in UI copy.
- **Security** — share tokens / invite flows must be explained in Settings (“who can join this sync”) to avoid accidental world-readable parties if misconfigured.

## Verification checklist

- [ ] Two Chrome profiles (or two machines) both open app → change label on A → appears on B without refresh or with a single refresh if polling.
- [ ] Incognito vs normal: document whether sync is supported or same-party rules apply.
- [ ] Build still passes: `npm run build` from repo root; no secrets in client bundle beyond public hostnames.

## References

- [Fireproof — Sharing and Sync](https://use-fireproof.com/docs/connect/)
- Existing: [prd.md](./prd.md) (user story 4, implementation decisions on sync), [plan.md](./plan.md) slice 7 outline
- Code: `news-feed/src/services/syncShare.ts`, `news-feed/src/hooks/useFeed.ts`

---

*Next step for Claude Code: run grill-me only if product needs to lock connector and pairing UX; otherwise start at S1 spike following [AGENTS.md](../../AGENTS.md) branch workflow.*
