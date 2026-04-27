# PRD — ai-topic-labels

## Problem

Boomerang's nine hardcoded built-in topics (`technology`, `science`, `world`, …) are coarse-grained and cannot express a reader's specific interests ("AI safety", "Rust", "climate policy"). The topic bar and `topicWeights` system only learns engagement intensity within these fixed buckets. Users on mobile — the primary device — have no way to apply richer filtering because the Chrome Prompt API is unavailable there.

## Solution (summary)

1. Let users define **user labels** (named categories). An initial set is suggested by on-device AI (Chrome Prompt API / Gemini Nano) based on their reading history; they accept, edit, or add labels freely.
2. After each feed load, a `requestIdleCallback` **classification pass** scores each article against every user label using the Prompt API and stores **label hits** in Fireproof.
3. Labels appear as **label badges** on article cards and as **topic pills** in the topic bar — pushing built-in topics to an overflow area as the user's label set grows.
4. Fireproof **cloud sync** replicates label definitions and label hits to all devices. Mobile users get labels and filtering without needing the Prompt API locally.
5. A **QR link flow** in Settings lets users pair a second device (phone) to the same Fireproof DB with one scan.

## User stories

1. **As a** desktop Chrome reader, **I want** the app to suggest personal labels based on what I've upvoted, **so that** I don't start from a blank slate.
2. **As a** reader, **I want** to add, rename, or delete my own labels, **so that** I can organize the feed around my exact interests.
3. **As a** reader, **I want** articles tagged with my labels automatically after the feed loads, **so that** I can filter to "AI safety" without manually curating anything.
4. **As a** mobile reader, **I want** my labels and tagged articles to appear on my phone, **so that** the work I did on desktop carries over.
5. **As a** reader, **I want** my labels to appear first in the topic bar with built-in topics available in overflow, **so that** the bar stays personal without losing the original categories.
6. **As a** reader, **I want** adding a new label to trigger reclassification of my existing article pool, **so that** past articles immediately benefit from the new label.

## Implementation decisions

### Data model

**`UserLabel`** (new type in `types.ts`):
```ts
interface UserLabel { id: string; name: string; color: string; }
```

**`UserPrefs`** additions:
```ts
userLabels: UserLabel[];          // ordered; user-defined + AI-accepted
activeLabelFilter: string | null; // labelId currently filtering the feed (persisted)
```

**Fireproof document — `ai-classifications`** (new, alongside `user-prefs` / `feed-cache`):
```ts
interface LabelHit { articleId: string; labelId: string; classifiedAt: number; }
interface ClassificationsDoc { _id: 'ai-classifications'; hits: LabelHit[]; }
```

**`Article`** — no new fields at the wire level. `userLabels: string[]` (label ids) is hydrated client-side at render time by joining `articleId` against loaded `LabelHit[]`. Never stored in `feed-cache`.

### Topic bar & filter state (`App.tsx`, `TopicFilter.tsx`)

- Expand `topicFilter` state from `Topic | null` to `ActiveFilter`:
  ```ts
  type ActiveFilter =
    | { kind: 'topic'; value: Topic }
    | { kind: 'label'; value: string }   // labelId
    | null;
  ```
- `TopicFilter` receives `userLabels: UserLabel[]` and `labelHits: LabelHit[]` as props.
- Rendering order: **All** pill → user labels (in order) → built-in topics collapsed into **More ▾** overflow button. If no user labels exist, topic bar looks identical to today (no overflow).
- Filtering in `App.tsx`: if `activeFilter.kind === 'label'`, filter `visibleArticles` by `labelHits` join; if `kind === 'topic'`, existing `a.topics.includes()` path unchanged.

### Classification service (`services/labelClassifier.ts`, new)

```ts
function isPromptApiAvailable(): boolean { return 'LanguageModel' in globalThis; }

async function classifyArticle(
  article: Article,
  label: UserLabel,
  session: LanguageModelSession,
): Promise<boolean>

async function runClassificationPass(
  articles: Article[],
  label: UserLabel,
  existingHits: Set<string>,   // `${articleId}:${labelId}` — skip already classified
  onHit: (hit: LabelHit) => void,
): Promise<void>               // uses requestIdleCallback between each article
```

- One shared `LanguageModel` session per pass; cloned per label (cheap).
- System prompt: `"You classify news articles. Answer only YES or NO."`
- User prompt per article: `"Label: ${label.name}\nHeadline: ${article.title}\nSummary: ${article.description}\nDoes this article belong under the label? Answer YES or NO."`
- Parse response: `res.trim().toUpperCase().startsWith('YES')`.
- Skips articles already in `existingHits` — idempotent reruns safe.

### Label suggestion service (`services/labelSuggester.ts`, new)

- Runs once on first Prompt API availability or when user clicks "Suggest labels".
- Input: top-weighted topics from `prefs.topicWeights`, top keywords from `prefs.keywordWeights`, titles of last 20 upvoted articles (from `prefs.upvotedIds` × `articlePool`).
- Prompt: `"Based on these reading interests: [summary], suggest 3–5 specific news topic labels (2–4 words each, no overlap with: Technology, Science, World, Business, Health, Environment, Sports, Entertainment). Return one label per line, nothing else."`
- Returns `string[]`; UI shows them as accept/dismiss chips before committing to `userLabels`.

### Fireproof cloud sync

- Add `@fireproof/connect` (or the current recommended Fireproof cloud connector).
- On first run: generate a sync token, store in `user-prefs` doc as `syncToken: string`.
- Subscribe `boomerang-news` DB to the cloud endpoint using the token.
- `ai-classifications` document replicates automatically alongside `user-prefs` and `feed-cache`.

### QR link flow (Settings)

- New "Sync across devices" section in Settings.
- Encodes sync token + cloud endpoint URL as a `boomerang://sync?token=…` deep link.
- Renders as a QR code (lightweight library, e.g. `qrcode` npm package, ~5KB gzip).
- On the receiving device: parse the link (via URL hash or custom scheme), configure Fireproof connector with the provided token.

### Prompt API availability

- All classification and suggestion features are gated on `isPromptApiAvailable()`.
- On unavailable browsers (all mobile, non-Chrome desktop, low-spec hardware): labels defined elsewhere still appear in the topic bar and on cards (from synced `ai-classifications`). No classification runs locally. Settings section shows "AI labelling requires Chrome 138+ on desktop."

### Delta reclassification (new label added)

- When a user label is added or accepted from suggestions:
  1. Add to `prefs.userLabels`, persist to Fireproof.
  2. If Prompt API available: schedule a classification pass for the new label only over the current `articlePool`.
  3. Progress: show a small spinner/count in Settings while running.

### Edge cases

- **No user labels yet:** topic bar is identical to today. No overflow, no badges.
- **Prompt API unavailable on desktop:** label management UI still works; classifications just never run locally (rely on sync from another device).
- **Empty article pool:** classification pass is a no-op.
- **Label deleted:** remove all `LabelHit` entries for that `labelId` from `ai-classifications` doc.

## Testing strategy

- **Unit:** `classifyArticle` with a mock session returning "YES"/"NO" — verify boolean output and idempotency.
- **Unit:** `runClassificationPass` skips articles in `existingHits`.
- **Unit:** `TopicFilter` renders user labels before built-in topics; overflow renders when labels present.
- **Unit:** `ActiveFilter` routing in `App` — label filter uses `LabelHit` join; topic filter uses `article.topics`.
- **Manual:** Chrome 138+ desktop — feed loads, classification runs idle, badges appear progressively.
- **Manual:** Sync flow — classify on desktop, scan QR on mobile, verify labels + badges appear.

## Out of scope (v1)

- Per-label confidence threshold (YES/NO only; no probability score)
- Label sharing between users
- Classification on mobile (mobile only consumes synced results)
- `chrome.storage.sync` extension approach
- OAuth / email login
- Label ordering / manual drag-to-reorder in Settings
