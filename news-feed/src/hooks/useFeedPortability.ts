import { useCallback } from 'react';
import type { MutableRefObject } from 'react';
import { kvSet } from '../services/kvStore';
import { DEFAULT_SOURCES } from '../services/newsService';
import {
  exportOPML, importOPML,
  exportBookmarkHTML, importBookmarkHTML,
} from '../services/storage';
import { dehydrate } from '../services/syncShare';
import type { Article, UserPrefs } from '../types';

export const IMPORTED_SAVES_ID = 'imported-saves';

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

interface UseFeedPortabilityParams {
  prefsRef: MutableRefObject<UserPrefs>;
  articlePoolRef: MutableRefObject<Article[]>;
  importedSavesRef: MutableRefObject<Article[]>;
  setImportedSaves: React.Dispatch<React.SetStateAction<Article[]>>;
  updatePrefs: (prefs: UserPrefs) => void;
  refresh: (prefs: UserPrefs, explicit?: boolean) => Promise<void>;
  fetchIdRef: MutableRefObject<number>;
  fetchingRef: MutableRefObject<boolean>;
}

export function useFeedPortability({
  prefsRef,
  articlePoolRef,
  importedSavesRef,
  setImportedSaves,
  updatePrefs,
  refresh,
  fetchIdRef,
  fetchingRef,
}: UseFeedPortabilityParams): {
  handleExportBookmarks: () => void;
  handleImportBookmarks: (html: string) => boolean;
  handleExportOPML: () => void;
  handleImportOPML: (xml: string) => boolean;
} {
  const handleExportBookmarks = useCallback(() => {
    const savedIds = new Set(prefsRef.current.savedIds);
    const savedAtById = prefsRef.current.savedAtById ?? {};
    const savedRank = new Map(prefsRef.current.savedIds.map((id, idx) => [id, idx]));
    const poolIds = new Set(articlePoolRef.current.map(a => a.id));
    const savedById = new Map<string, Article>();
    for (const article of articlePoolRef.current) {
      if (savedIds.has(article.id)) savedById.set(article.id, article);
    }
    for (const article of importedSavesRef.current) {
      if (savedIds.has(article.id) && !poolIds.has(article.id)) savedById.set(article.id, article);
    }
    const allSaved = prefsRef.current.savedIds
      .slice()
      .sort((a, b) => {
        const ta = savedAtById[a] ?? 0;
        const tb = savedAtById[b] ?? 0;
        if (tb !== ta) return tb - ta;
        return (savedRank.get(b) ?? 0) - (savedRank.get(a) ?? 0);
      })
      .map(id => savedById.get(id))
      .filter((article): article is Article => article !== undefined);
    const html = exportBookmarkHTML(allSaved);
    triggerDownload(new Blob([html], { type: 'text/html' }), 'boomerang-saves.html');
  }, [prefsRef, articlePoolRef, importedSavesRef]);

  const handleImportBookmarks = useCallback((html: string): boolean => {
    const parsed = importBookmarkHTML(html);
    if (!parsed) return false;
    const existing = new Map(importedSavesRef.current.map(a => [a.id, a]));
    for (const a of parsed) existing.set(a.id, a);
    const merged = Array.from(existing.values());
    importedSavesRef.current = merged;
    setImportedSaves(merged);
    kvSet(IMPORTED_SAVES_ID, { articles: dehydrate(merged) }).catch(console.error);
    const existingSaved = new Set(prefsRef.current.savedIds);
    const newIds = parsed.map(a => a.id).filter(id => !existingSaved.has(id));
    if (newIds.length) {
      const now = Date.now();
      const publishedById = new Map(parsed.map(a => [a.id, a.publishedAt.getTime()]));
      const nextSavedAtById = { ...(prefsRef.current.savedAtById ?? {}) };
      const nextUnsavedAtById = { ...(prefsRef.current.unsavedAtById ?? {}) };
      for (const id of newIds) {
        nextSavedAtById[id] = publishedById.get(id) ?? now;
        delete nextUnsavedAtById[id];
      }
      updatePrefs({
        ...prefsRef.current,
        savedIds: [...prefsRef.current.savedIds, ...newIds],
        savedAtById: nextSavedAtById,
        unsavedAtById: nextUnsavedAtById,
      });
    }
    return true;
  }, [prefsRef, importedSavesRef, setImportedSaves, updatePrefs]);

  const handleExportOPML = useCallback(() => {
    const { disabledSourceIds = [], customSources = [] } = prefsRef.current;
    const xml = exportOPML(DEFAULT_SOURCES, customSources, disabledSourceIds);
    triggerDownload(new Blob([xml], { type: 'application/xml' }), 'boomerang-feeds.opml');
  }, [prefsRef]);

  const handleImportOPML = useCallback((xml: string): boolean => {
    const result = importOPML(xml, DEFAULT_SOURCES);
    if (!result) return false;
    const next: UserPrefs = {
      ...prefsRef.current,
      disabledSourceIds: result.disabledSourceIds,
      customSources: result.customSources,
    };
    updatePrefs(next);
    fetchIdRef.current++;
    fetchingRef.current = false;
    refresh(next, true);
    return true;
  }, [prefsRef, updatePrefs, refresh, fetchIdRef, fetchingRef]);

  return { handleExportBookmarks, handleImportBookmarks, handleExportOPML, handleImportOPML };
}
