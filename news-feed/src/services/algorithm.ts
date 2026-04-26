import type { Article, Topic, UserPrefs } from '../types';
import { filterAds } from './adFilter';
import { extractKeywords, isTopicEnabled } from './storage';
import { inferFetchTier } from './fetchTier';

export { inferFetchTier };

/** Per PRD: background-tier (P2 + custom) scores lower so re-rank does not float them above P1. */
const BACKGROUND_TIER_SCORE_MULTIPLIER = 0.2;

// Exponential decay: half-life of 12 hours
function recencyScore(publishedAt: Date): number {
  const ageHours = (Date.now() - publishedAt.getTime()) / 3_600_000;
  return Math.exp(-0.0578 * ageHours); // ln(2)/12
}

// Levenshtein distance (simplified) for deduplication
function titleSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const wordsB = new Set(b.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let shared = 0;
  wordsA.forEach(w => { if (wordsB.has(w)) shared++; });
  return shared / Math.max(wordsA.size, wordsB.size);
}

/** Fuzzy dedupe — O(n²); fine for small pools. */
function deduplicateArticlesFuzzy(articles: Article[]): Article[] {
  const unique: Article[] = [];
  for (const article of articles) {
    const isDupe = unique.some(u => titleSimilarity(u.title, article.title) > 0.65);
    if (!isDupe) unique.push(article);
  }
  return unique;
}

/** Per-source + normalized title key — O(n); used when the pool is large (many RSS sources). */
function deduplicateArticlesFast(articles: Article[]): Article[] {
  const unique: Article[] = [];
  const seen = new Set<string>();
  for (const article of articles) {
    const key = `${article.sourceId}\u0000${article.title.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 160)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(article);
  }
  return unique;
}

/** Above this size, fuzzy pairwise dedupe can block the main thread for seconds. */
const FUZZY_DEDUPE_MAX = 350;

export function deduplicateArticles(articles: Article[]): Article[] {
  if (articles.length <= FUZZY_DEDUPE_MAX) return deduplicateArticlesFuzzy(articles);
  return deduplicateArticlesFast(articles);
}

export function scoreArticle(article: Article, prefs: UserPrefs, sourceArticleCounts: Record<string, number>): number {
  // Recency (0–1)
  const r = recencyScore(article.publishedAt);

  // Source quality weight (clamped so downvoted sources still appear, just less)
  const srcW = Math.max(prefs.sourceWeights[article.sourceId] ?? 1.0, 0.1);

  // Topic relevance based on user engagement
  const topicScore = article.topics.reduce((acc: number, t: Topic) => {
    return acc + (prefs.topicWeights[t] ?? 1.0);
  }, 0) / article.topics.length;

  // Source diversity: diminishing returns if source dominates feed
  const srcCount = sourceArticleCounts[article.sourceId] ?? 0;
  const diversity = 1 / (1 + Math.log1p(srcCount));

  // Keyword affinity: sum learned weights for words in title+description,
  // bounded by tanh so it nudges ranking rather than overwhelming recency.
  const kwRaw = extractKeywords(article.title + ' ' + article.description)
    .reduce((sum, kw) => sum + (prefs.keywordWeights[kw] ?? 0), 0);
  const kwBonus = Math.tanh(kwRaw) * 0.5;

  let s = r * srcW * topicScore * diversity + kwBonus;
  if (inferFetchTier(article) === 'background') s *= BACKGROUND_TIER_SCORE_MULTIPLIER;
  return s;
}

export function rankFeed(articles: Article[], prefs: UserPrefs): Article[] {
  // Filter articles already read or seen; keep downvoted (they render collapsed at the end)
  const seenSet     = new Set([...prefs.readIds, ...prefs.seenIds]);
  const downvoteSet = new Set(prefs.downvotedIds);
  const unread     = articles.filter(a => !seenSet.has(a.id) && !downvoteSet.has(a.id));
  const downvoted  = articles.filter(a => downvoteSet.has(a.id) && !seenSet.has(a.id));

  // Remove promotional / ad content
  const nonAd = filterAds(unread);

  // Apply topic filter from Settings (enabledTopics = [] means all enabled)
  const topicFiltered = prefs.enabledTopics.length === 0
    ? nonAd
    : nonAd.filter(a => a.topics.some(t => isTopicEnabled(t, prefs)));

  // Deduplicate similar stories
  const unique = deduplicateArticles(topicFiltered);

  // Count per source before scoring (approximate diversity)
  const counts: Record<string, number> = {};
  unique.forEach(a => { counts[a.sourceId] = (counts[a.sourceId] ?? 0) + 1; });

  // Score and sort
  const scored = unique.map(a => ({ ...a, score: scoreArticle(a, prefs, counts) }));
  scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  // Interleave to avoid same-source clustering: spread articles across feed
  const result: Article[] = [];
  const buckets: Record<string, Article[]> = {};
  scored.forEach(a => {
    if (!buckets[a.sourceId]) buckets[a.sourceId] = [];
    buckets[a.sourceId].push(a);
  });
  const keys = Object.keys(buckets);
  const maxLen = Math.max(...keys.map(k => buckets[k].length));
  for (let i = 0; i < maxLen; i++) {
    for (const k of keys) {
      if (buckets[k][i]) result.push(buckets[k][i]);
    }
  }

  // Downvoted articles appear collapsed at the very bottom
  return [...result, ...downvoted];
}
