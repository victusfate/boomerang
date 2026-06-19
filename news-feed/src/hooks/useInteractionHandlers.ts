import { useCallback } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { kvSet } from '../services/kvStore';
import { writeHistoryEntry, writeHistoryEntries } from '../services/articleHistory';
import {
  markRead, markSeen, toggleSaved, clearQueue,
  boostTopic, upvote, downvote,
} from '../services/storage';
import { dehydrate } from '../services/syncShare';
import type { Article, UserPrefs } from '../types';
import type { RecInteractionInput } from '../services/recWorker';
import { IMPORTED_SAVES_ID } from './useFeedPortability';

interface HistoryEntry {
  id: string; title: string; url: string; source: string; sourceId: string;
  publishedAt: string; interactedAt: number;
}

function toHistoryEntry(article: Article, interactedAt: number): HistoryEntry {
  return {
    id: article.id, title: article.title, url: article.url,
    source: article.source, sourceId: article.sourceId,
    publishedAt: article.publishedAt.toISOString(), interactedAt,
  };
}

export interface UseInteractionHandlersParams {
  prefsRef: MutableRefObject<UserPrefs>;
  updatePrefs: (next: UserPrefs) => void;
  allArticlesRef: MutableRefObject<Article[]>;
  articleTagsMapRef: MutableRefObject<Map<string, string[]>>;
  markedSeenRef: MutableRefObject<Set<string>>;
  recInteractRef: MutableRefObject<((input: RecInteractionInput) => void) | undefined>;
  importedSavesRef: MutableRefObject<Article[]>;
  setImportedSaves: Dispatch<SetStateAction<Article[]>>;
}

export interface UseInteractionHandlersResult {
  onOpen: (article: Article) => void;
  onSave: (id: string) => void;
  onSaveExternal: (article: Article) => void;
  onClearQueue: () => void;
  onUpvote: (article: Article) => void;
  onDownvote: (article: Article) => void;
  onSeen: (id: string) => void;
}

export function useInteractionHandlers(params: UseInteractionHandlersParams): UseInteractionHandlersResult {
  const {
    prefsRef, updatePrefs,
    allArticlesRef, articleTagsMapRef, markedSeenRef, recInteractRef,
    importedSavesRef, setImportedSaves,
  } = params;

  // Saved articles can live outside the RSS pool (imported bookmarks, aged-out
  // saves) — history writes on dequeue must find those too.
  const findKnownArticle = useCallback((id: string): Article | undefined =>
    allArticlesRef.current.find(a => a.id === id)
    ?? importedSavesRef.current.find(a => a.id === id), [allArticlesRef, importedSavesRef]);

  const onOpen = useCallback((article: Article) => {
    const afterRead = markRead(article.id, prefsRef.current);
    const afterBoost = article.topics.reduce((p, t) => boostTopic(t, p), afterRead);
    const afterDequeue = afterBoost.savedIds.includes(article.id)
      ? toggleSaved(article.id, afterBoost)
      : afterBoost;
    updatePrefs(afterDequeue);
    recInteractRef.current?.({
      articleId: article.id, sourceId: article.sourceId, topics: article.topics,
      tags: articleTagsMapRef.current.get(article.id), action: 'read', ts: Date.now(),
    });
    void writeHistoryEntry(toHistoryEntry(article, Date.now()));
  }, [prefsRef, updatePrefs, recInteractRef, articleTagsMapRef]);

  const onSave = useCallback((id: string) => {
    const isSaving = !prefsRef.current.savedIds.includes(id);
    updatePrefs(toggleSaved(id, prefsRef.current));
    const a = findKnownArticle(id);
    if (a && isSaving) recInteractRef.current?.({
      articleId: a.id, sourceId: a.sourceId, topics: a.topics,
      tags: articleTagsMapRef.current.get(a.id), action: 'save', ts: Date.now(),
    });
    if (a && !isSaving) void writeHistoryEntry(toHistoryEntry(a, Date.now()));
  }, [prefsRef, updatePrefs, findKnownArticle, recInteractRef, articleTagsMapRef]);

  // Registers an out-of-pool article in importedSaves so it appears in the Queue,
  // then delegates to onSave for the actual prefs update.
  const onSaveExternal = useCallback((article: Article) => {
    if (!findKnownArticle(article.id) && !prefsRef.current.savedIds.includes(article.id)) {
      const merged = [...importedSavesRef.current.filter(a => a.id !== article.id), article];
      importedSavesRef.current = merged;
      setImportedSaves(merged);
      kvSet(IMPORTED_SAVES_ID, { articles: dehydrate(merged) }).catch(console.error);
    }
    onSave(article.id);
  }, [prefsRef, findKnownArticle, importedSavesRef, setImportedSaves, onSave]);

  const onClearQueue = useCallback(() => {
    const currentSaved = prefsRef.current.savedIds;
    const now = Date.now();
    updatePrefs(clearQueue(prefsRef.current));
    const entries = currentSaved
      .map(id => {
        const article = findKnownArticle(id);
        return article ? toHistoryEntry(article, now) : null;
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);
    if (entries.length > 0) void writeHistoryEntries(entries);
  }, [prefsRef, updatePrefs, findKnownArticle]);

  const onUpvote = useCallback((article: Article) => {
    updatePrefs(upvote(article, prefsRef.current));
    recInteractRef.current?.({
      articleId: article.id, sourceId: article.sourceId, topics: article.topics,
      tags: articleTagsMapRef.current.get(article.id), action: 'upvote', ts: Date.now(),
    });
  }, [prefsRef, updatePrefs, recInteractRef, articleTagsMapRef]);

  const onDownvote = useCallback((article: Article) => {
    updatePrefs(downvote(article, prefsRef.current));
    recInteractRef.current?.({
      articleId: article.id, sourceId: article.sourceId, topics: article.topics,
      tags: articleTagsMapRef.current.get(article.id), action: 'downvote', ts: Date.now(),
    });
  }, [prefsRef, updatePrefs, recInteractRef, articleTagsMapRef]);

  const onSeen = useCallback((id: string) => {
    if (markedSeenRef.current.has(id)) return;
    markedSeenRef.current.add(id);
    updatePrefs(markSeen([id], prefsRef.current));
    const a = allArticlesRef.current.find(x => x.id === id);
    if (a) recInteractRef.current?.({
      articleId: a.id, sourceId: a.sourceId, topics: a.topics,
      tags: articleTagsMapRef.current.get(a.id), action: 'seen', ts: Date.now(),
    });
  }, [prefsRef, updatePrefs, markedSeenRef, allArticlesRef, recInteractRef, articleTagsMapRef]);

  return { onOpen, onSave, onSaveExternal, onClearQueue, onUpvote, onDownvote, onSeen };
}
