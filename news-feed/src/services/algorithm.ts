import type { Article, Topic, UserPrefs } from '../types';

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

export function deduplicateArticles(articles: Article[]): Article[] {
  const unique: Article[] = [];
  for (const article of articles) {
    const isDupe = unique.some(u => titleSimilarity(u.title, article.title) > 0.65);
    if (!isDupe) unique.push(article);
  }
  return unique;
}

export function scoreArticle(article: Article, prefs: UserPrefs, sourceArticleCounts: Record<string, number>): number {
  // Recency (0–1)
  const r = recencyScore(article.publishedAt);

  // Source quality weight
  const srcW = prefs.sourceWeights[article.sourceId] ?? 1.0;

  // Topic relevance based on user engagement
  const topicScore = article.topics.reduce((acc: number, t: Topic) => {
    return acc + (prefs.topicWeights[t] ?? 1.0);
  }, 0) / article.topics.length;

  // Source diversity: diminishing returns if source dominates feed
  const srcCount = sourceArticleCounts[article.sourceId] ?? 0;
  const diversity = 1 / (1 + Math.log1p(srcCount));

  return r * srcW * topicScore * diversity;
}

export function rankFeed(articles: Article[], prefs: UserPrefs): Article[] {
  // Filter articles already read or seen in a previous session
  const seenSet = new Set([...prefs.readIds, ...prefs.seenIds]);
  const unread = articles.filter(a => !seenSet.has(a.id));

  // Deduplicate similar stories
  const unique = deduplicateArticles(unread);

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

  return result;
}
