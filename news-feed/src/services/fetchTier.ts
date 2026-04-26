import type { Article, NewsSource } from '../types';
import rssSourcesJson from '../../../shared/rss-sources.json';

const BUILTIN: NewsSource[] = rssSourcesJson as NewsSource[];

/** When re-ranking articles without `fetchTier` (e.g. cache) or to validate tier. */
export function inferFetchTier(article: Article, builtins: NewsSource[] = BUILTIN): 'fast' | 'background' {
  if (article.fetchTier) return article.fetchTier;
  if (article.sourceId.startsWith('custom-')) return 'background';
  const s = builtins.find(b => b.id === article.sourceId);
  if (!s) return 'background';
  return (s.priority ?? 2) === 1 ? 'fast' : 'background';
}
