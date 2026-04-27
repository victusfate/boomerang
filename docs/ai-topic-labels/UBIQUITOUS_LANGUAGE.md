# Ubiquitous language — ai-topic-labels

## Canonical terms

| Term | Definition | Ambiguity / notes |
|------|------------|-------------------|
| **User label** | A named category defined by or accepted by the user (e.g. "AI safety", "Rust"). Stored in `UserPrefs`. Not the same as a built-in topic. | Prefer "user label" over "tag", "custom tag", or "custom category" — all mean the same thing here. |
| **Built-in topic** | One of the nine hardcoded `Topic` values (`technology`, `science`, `world`, …) already in `types.ts`. Rendered as topic pills today. | Prefer "built-in topic" over "chip", "static topic", or "RSS category". |
| **Topic pill** | The clickable filter button in the topic bar. Renders both built-in topics and user labels after this feature ships. | "chip" = same thing in conversation; use "topic pill" in code and docs. |
| **Topic bar** | The horizontal scrollable row of topic pills below the feed tabs. | Also called "filter bar" in conversation — use "topic bar". |
| **Label badge** | The small label tag rendered on an article card showing which user labels apply to it. | Not the same as the topic pill — badge is read-only on the card; pill is interactive in the bar. |
| **Classification** | The act of running the Prompt API against an article to determine which user labels apply. Produces a `LabelHit[]`. | Prefer "classification" over "tagging" or "inference". |
| **Label hit** | A single result record: `{ articleId, label, classifiedAt }`. Stored in Fireproof. | The unit of persisted classification output. |
| **Classification pass** | One full batch run of the Prompt API over a set of articles for a single label. Runs via `requestIdleCallback`. | Distinguish from a single classification (one article × one label). |
| **Label suggestion** | An AI-generated candidate label proposed to the user based on reading history. Requires user acceptance before becoming a user label. | Not yet a user label until accepted. |
| **Sync token** | The anonymous Fireproof cloud credential (a generated key) that links the user's DB across devices. Encoded in the QR code. | Not a login, not OAuth — purely a capability token. |
| **QR link flow** | The Settings screen where the user displays a QR code containing the sync token for scanning on a second device. | "Sync flow", "device pairing" = same thing — use "QR link flow". |
| **Article pool** | The in-memory set of all fetched articles for the current session (`articlePoolRef` in `useFeed.ts`). | Same term as in `fast-initial-fetch`. |
| **Prompt API** | `window.LanguageModel` — Chrome 138+ on-device Gemini Nano. Only available on capable desktop browsers. | Not "AI API", not "Gemini API". On-device only — no cloud calls. |
| **Overflow** | The collapsed section of the topic bar that holds built-in topics pushed out by user labels. | Not "hidden topics" or "more topics". |

## Ambiguities resolved

- **"tag" vs "label"**: Use **user label** everywhere. "Tag" is overloaded (HTML, git, RSS). 
- **"chip" vs "pill"**: Use **topic pill** in code/docs. "Chip" is fine in conversation but not in code.
- **"topic" alone**: Without qualifier means a built-in topic (`Topic` type). Always say **user label** for user-defined categories.
- **"sync"**: In this feature means Fireproof cloud DB replication. Unrelated to browser profile sync or `chrome.storage.sync`.
- **"priority"**: In this feature context refers to `NewsSource.priority` (fetch tier), not React image `fetchPriority` or user label priority. Avoid using "priority" to describe label ordering.
