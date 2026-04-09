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

export interface UserPrefs {
  topicWeights: Partial<Record<Topic, number>>;
  sourceWeights: Record<string, number>;
  readIds: string[];
  savedIds: string[];
  seenIds: string[];       // articles shown in feed — filtered on next refresh
  enabledSources: string[];
  enabledTopics: Topic[];
}

export type FeedView = 'feed' | 'saved' | 'settings';
