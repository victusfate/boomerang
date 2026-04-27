# Grill-me — ai-topic-labels

**Slug:** `ai-topic-labels`

## Q1 — Cross-device sync for AI-generated classifications

**Decision:** Fireproof cloud sync. Classifications live in the existing `boomerang-news` Fireproof DB and replicate automatically across devices. No new backend infrastructure; fits the existing no-account philosophy.

Rationale: Small append-only data (`articleId → labels[]`); Fireproof cloud handles replication passively in the background.

## Q2 — Where do custom labels come from?

**Decision:** Both — AI suggests an initial label set by scanning the user's reading history (upvoted articles, high-weight topics in prefs), and the user can add, edit, or delete labels freely at any time.

Rationale: Seeding with AI suggestions solves the blank-slate problem for new users; manual control keeps the system useful for power users with specific interests.

## Q3 — When does classification run?

**Decision:** `requestIdleCallback` batch after the feed finishes loading. Classification never blocks the fetch/rank pipeline or scroll. Labels appear on cards progressively as the batch completes. Fireproof-cached results from prior sessions fill in most cards instantly on return visits.

## Q4 — How are labels surfaced in the UI?

**Decision:** Both — a badge on each article card and a filterable pill in the topic bar. Clicking a label pill filters the feed to articles tagged with that label.

## Q5 — Coexistence with existing topic chips

**Decision:** Soft takeover. AI labels appear first in the topic bar; built-in hardcoded topic chips (Tech, Science, World…) slide to an overflow area as the user builds their label set. Day one the bar looks identical to today. Casual users never notice; power users end up with a fully personalized bar. Built-in topics remain discoverable in overflow — never removed.

## Q6 — Reclassification when a new label is added

**Decision:** Background reclassify the full article pool against the new label only (delta pass — not all labels). A few hundred Prompt API calls via `requestIdleCallback`. Progress can be shown in Settings if the pass is long.

## Q7 — Device linking / user identity

**Decision:** Anonymous Fireproof sync token with a QR code linking flow in Settings. User scans the QR on their phone, one tap links the DB — no accounts, no OAuth, no PII on any server. Token is generated once per install and stored in Fireproof prefs.

Rationale: Matches Boomerang's existing no-account philosophy. A companion browser extension using `chrome.storage.sync` is a future enhancement, not v1.

## Out of scope (v1)

- Chrome/Firefox extension using `chrome.storage.sync`
- OAuth / email login
- Classification of articles on mobile (Prompt API unavailable) — mobile only *consumes* synced labels
- Per-label confidence thresholds / probability scores
- Sharing label sets between users
