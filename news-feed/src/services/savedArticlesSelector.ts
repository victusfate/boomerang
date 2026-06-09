import type { Article, UserPrefs } from '../types';

/**
 * Assemble the saved-articles view: resolve each saved id from the live pool
 * (pool wins) or imported bookmarks, ordered by savedAt desc then star order.
 * Single source of truth for the Queue tab and bookmark export.
 */
export function selectSavedArticles(
  prefs: UserPrefs,
  pool: Article[],
  importedSaves: Article[],
): Article[] {
  const savedIds = new Set(prefs.savedIds);
  const savedAtById = prefs.savedAtById ?? {};
  const savedRank = new Map(prefs.savedIds.map((id, idx) => [id, idx]));
  const poolIds = new Set(pool.map(a => a.id));
  const savedById = new Map<string, Article>();
  for (const article of pool) {
    if (savedIds.has(article.id)) savedById.set(article.id, article);
  }
  for (const article of importedSaves) {
    if (savedIds.has(article.id) && !poolIds.has(article.id)) savedById.set(article.id, article);
  }
  return prefs.savedIds
    .slice()
    .sort((a, b) => {
      const ta = savedAtById[a] ?? 0;
      const tb = savedAtById[b] ?? 0;
      if (tb !== ta) return tb - ta;
      return (savedRank.get(b) ?? 0) - (savedRank.get(a) ?? 0);
    })
    .map(id => savedById.get(id))
    .filter((article): article is Article => article !== undefined);
}
