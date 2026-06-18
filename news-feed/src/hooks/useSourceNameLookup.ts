import { useCallback, useMemo } from 'react';
import type { Article } from '../types';

export function useSourceNameLookup(
  allArticles: Article[],
  savedArticles: Article[],
): { getSourceName: (sourceId: string) => string } {
  const sourceDisplayBySourceId = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of allArticles) {
      if (!m.has(a.sourceId)) m.set(a.sourceId, a.source);
    }
    for (const a of savedArticles) {
      if (!m.has(a.sourceId)) m.set(a.sourceId, a.source);
    }
    return m;
  }, [allArticles, savedArticles]);

  const getSourceName = useCallback(
    (sourceId: string) => sourceDisplayBySourceId.get(sourceId) ?? sourceId,
    [sourceDisplayBySourceId],
  );

  return { getSourceName };
}
