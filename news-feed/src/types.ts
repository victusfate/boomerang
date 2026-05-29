/**
 * Core domain types shared across news-feed components, services, and hooks.
 * @module types
 * @category Types
 */

/** A user-defined label used to classify saved articles. */
export interface UserLabel {
  id: string;
  name: string;
  color: string;
}

/** Records that an article was matched to a user label by the AI classifier. */
export interface LabelHit {
  articleId: string;
  labelId: string;
  classifiedAt: number;
}

/** AI-generated topic tags for a single article, synced via MetaDO. */
export interface ArticleTag {
  articleId: string;
  tags: string[];
  taggedAt: number;
}

/** Active feed filter — either a topic or a user label. */
export type ActiveFilter =
  | { kind: 'topic'; value: Topic }
  | { kind: 'label'; value: string }
  | null;

/** A single news article as stored in IndexedDB and passed through the feed pipeline. */
export interface Article {
  id: string;
  title: string;
  url: string;
  description: string;
  imageUrl?: string;
  publishedAt: Date;
  source: string;
  sourceId: string;
  topics: Topic[];
  score?: number;
  /** Set when loading via split fetch: fast = priority-1 built-in; background = priority-2 + all custom OPML */
  fetchTier?: 'fast' | 'background';
  /** Discussion thread URL, e.g. HN comments page from RSS <comments> field */
  discussionUrl?: string;
}

/** Content topic category. */
export type Topic =
  | 'technology'
  | 'science'
  | 'world'
  | 'business'
  | 'health'
  | 'environment'
  | 'sports'
  | 'entertainment'
  | 'general';

/** A built-in RSS/Atom news source. */
export interface NewsSource {
  id: string;
  name: string;
  feedUrl: string;
  category: Topic;
  enabled: boolean;
  priority?: 1 | 2;  // 1 = render first; 2 = background batch (default)
}

/** A user-supplied custom OPML/RSS/Atom feed source. */
export interface CustomSource {
  id: string;       // e.g. 'custom-1abc2'
  name: string;     // display name
  feedUrl: string;  // RSS/Atom feed URL
}

/** Persisted user preferences — stored in Fireproof IndexedDB and synced via the sync worker. */
export interface UserPrefs {
  topicWeights:   Partial<Record<Topic, number>>;
  sourceWeights:  Record<string, number>;
  keywordWeights: Record<string, number>;  // per-word learned signal
  readIds:        string[];
  savedIds:       string[];
  /** Save timestamp per article id (epoch ms), used for cross-device saved ordering. */
  savedAtById?:   Record<string, number>;
  /** Unsave tombstone timestamp per article id (epoch ms), for cross-device delete wins. */
  unsavedAtById?: Record<string, number>;
  seenIds:        string[];           // articles shown in feed — filtered on next refresh
  upvotedIds:     string[];           // explicit likes
  downvotedIds:   string[];           // permanently hidden
  lastDecayAt:    number;             // timestamp for periodic weight decay
  /** @deprecated legacy whitelist — kept only for one-time migration to disabledSourceIds */
  enabledSources: string[];
  disabledSourceIds: string[];        // blacklist: empty = all enabled
  enabledTopics:  Topic[];
  customSources:  CustomSource[];
  userLabels:     UserLabel[];
  hideAiBar:      boolean;
  theme:          'dark' | 'light';
}

/** Current view shown to the user. */
export type FeedView = 'feed' | 'saved' | 'rec';
