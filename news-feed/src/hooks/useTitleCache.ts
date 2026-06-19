import { useCallback, useEffect, useMemo, useState } from 'react';
import { saveTitles, loadTitleCache } from '../services/titleCache';
import type { Article } from '../types';

export function useTitleCache(
  allArticles: Article[],
  savedArticles: Article[],
): { getArticleTitle: (id: string) => string | null } {
  const [persistedTitles, setPersistedTitles] = useState<Record<string, string>>({});

  useEffect(() => {
    void loadTitleCache().then(setPersistedTitles);
  }, []);

  useEffect(() => {
    const articles = [...allArticles, ...savedArticles];
    if (articles.length > 0) void saveTitles(articles);
  }, [allArticles, savedArticles]);

  const articleTitleById = useMemo(() => {
    const map = new Map<string, string>(Object.entries(persistedTitles));
    for (const article of allArticles) map.set(article.id, article.title);
    for (const article of savedArticles) map.set(article.id, article.title);
    return map;
  }, [allArticles, savedArticles, persistedTitles]);

  const getArticleTitle = useCallback(
    (id: string) => articleTitleById.get(id) ?? null,
    [articleTitleById],
  );

  return { getArticleTitle };
}
