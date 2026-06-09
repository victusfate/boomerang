import type { Article, NewsSource } from '../types';
import rssSourcesJson from '../../../shared/rss-sources.json' with { type: 'json' };

const BUILTIN: NewsSource[] = rssSourcesJson as NewsSource[];
const BUILTIN_BY_ID = new Map(BUILTIN.map(s => [s.id, s]));

/** When re-ranking articles without `fetchTier` (e.g. cache) or to validate tier. */
export function inferFetchTier(article: Article, builtins?: NewsSource[]): 'fast' | 'background' {
  if (article.fetchTier) return article.fetchTier;
  if (article.sourceId.startsWith('custom-')) return 'background';
  const s = builtins
    ? builtins.find(b => b.id === article.sourceId)
    : BUILTIN_BY_ID.get(article.sourceId);
  if (!s) return 'background';
  return (s.priority ?? 2) === 1 ? 'fast' : 'background';
}
