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

export interface NewsSource {
  id: string;
  name: string;
  feedUrl: string;
  category: Topic;
  enabled: boolean;
  priority?: 1 | 2;  // 1 = render first; 2 = background batch (default)
}

export interface CustomSource {
  id: string;       // e.g. 'custom-1abc2'
  name: string;     // display name
  feedUrl: string;  // RSS/Atom feed URL
}

export interface UserPrefs {
  topicWeights:   Partial<Record<Topic, number>>;
  sourceWeights:  Record<string, number>;
  keywordWeights: Record<string, number>;  // per-word learned signal
  readIds:        string[];
  savedIds:       string[];
  seenIds:        string[];           // articles shown in feed — filtered on next refresh
  upvotedIds:     string[];           // explicit likes
  downvotedIds:   string[];           // permanently hidden
  lastDecayAt:    number;             // timestamp for periodic weight decay
  /** @deprecated legacy whitelist — kept only for one-time migration to disabledSourceIds */
  enabledSources: string[];
  disabledSourceIds: string[];        // blacklist: empty = all enabled
  enabledTopics:  Topic[];
  customSources:  CustomSource[];
}

export type FeedView = 'feed' | 'saved' | 'settings';
