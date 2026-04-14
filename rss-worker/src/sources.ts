/**
 * Allowlisted RSS sources — loaded from `shared/rss-sources.json` (single source of truth with news-feed).
 * Worker only fetches URLs defined here (SSRF-safe).
 */

import rssSourcesJson from '../../shared/rss-sources.json';

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
  priority?: 1 | 2;
}

export const DEFAULT_SOURCES: NewsSource[] = rssSourcesJson as NewsSource[];

export const SOURCE_BY_ID = new Map(DEFAULT_SOURCES.map(s => [s.id, s]));
