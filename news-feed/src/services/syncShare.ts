/**
 * Sync-share URL builder and parser — encodes/decodes prefs + saved articles as a URL fragment.
 * @module services/syncShare
 * @category Sync
 */

import { MAX_READ_IDS, MAX_SEEN_IDS } from './storage.ts';
import { isSyncDebugEnabled } from '../config/debugSync.ts';
import type { Article, ArticleTag, LabelHit, Topic, UserPrefs } from '../types.ts';

export const SYNC_LOG = '[Sync]';

export type StoredArticle = Omit<Article, 'publishedAt'> & { publishedAt: string };

export interface SyncPayloadV1 {
  v: 1;
  prefs: UserPrefs;
  savedArticles: StoredArticle[];
  articleTags: ArticleTag[];
  labelHits: LabelHit[];
}

export function hydrate(stored: StoredArticle[]): Article[] {
  return stored.map(a => ({ ...a, publishedAt: new Date(a.publishedAt) }));
}

export function dehydrate(articles: Article[]): StoredArticle[] {
  return articles.map(a => ({ ...a, publishedAt: a.publishedAt.toISOString() }));
}

function fromBase64Url(encoded: string): string {
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function uniqueStrings(...groups: (string[] | undefined)[]): string[] {
  return [...new Set(groups.flatMap(g => g ?? []))];
}

function mergeById<T extends { id: string }>(left: T[], right: T[]): T[] {
  return Array.from(new Map([...left, ...right].map(item => [item.id, item])).values());
}

/** Keep the most-recent (tail) entries — matches markRead/markSeen eviction. */
function capTail<T>(items: T[], max: number): T[] {
  return items.length > max ? items.slice(-max) : items;
}

export function mergePrefs(left: UserPrefs, right: Partial<UserPrefs>): UserPrefs {
  const mergedSavedAtById: Record<string, number> = { ...(left.savedAtById ?? {}) };
  for (const [id, ts] of Object.entries(right.savedAtById ?? {})) {
    const prev = mergedSavedAtById[id] ?? 0;
    mergedSavedAtById[id] = Math.max(prev, ts);
  }
  const mergedUnsavedAtById: Record<string, number> = { ...(left.unsavedAtById ?? {}) };
  for (const [id, ts] of Object.entries(right.unsavedAtById ?? {})) {
    const prev = mergedUnsavedAtById[id] ?? 0;
    mergedUnsavedAtById[id] = Math.max(prev, ts);
  }
  const legacySavedIds = uniqueStrings(left.savedIds, right.savedIds);
  const allIds = new Set<string>([
    ...legacySavedIds,
    ...Object.keys(mergedSavedAtById),
    ...Object.keys(mergedUnsavedAtById),
  ]);
  const finalSavedIds: string[] = [];
  const hasId = new Set<string>();
  for (const id of legacySavedIds) {
    const savedAt = mergedSavedAtById[id] ?? 0;
    const unsavedAt = mergedUnsavedAtById[id] ?? 0;
    const keepSaved = (savedAt === 0 && unsavedAt === 0) || savedAt > unsavedAt;
    if (keepSaved && !hasId.has(id)) {
      finalSavedIds.push(id);
      hasId.add(id);
    }
    allIds.delete(id);
  }
  for (const id of allIds) {
    const savedAt = mergedSavedAtById[id] ?? 0;
    const unsavedAt = mergedUnsavedAtById[id] ?? 0;
    if (savedAt > unsavedAt) finalSavedIds.push(id);
  }
  return {
    ...left,
    topicWeights:   { ...left.topicWeights, ...(right.topicWeights ?? {}) },
    sourceWeights:  { ...left.sourceWeights, ...(right.sourceWeights ?? {}) },
    keywordWeights: { ...left.keywordWeights, ...(right.keywordWeights ?? {}) },
    readIds:        capTail(uniqueStrings(left.readIds, right.readIds), MAX_READ_IDS),
    savedIds:       finalSavedIds,
    savedAtById:    mergedSavedAtById,
    unsavedAtById:  mergedUnsavedAtById,
    seenIds:        capTail(uniqueStrings(left.seenIds, right.seenIds), MAX_SEEN_IDS),
    upvotedIds:     uniqueStrings(left.upvotedIds, right.upvotedIds),
    downvotedIds:   uniqueStrings(left.downvotedIds, right.downvotedIds),
    lastDecayAt:    Math.max(left.lastDecayAt, right.lastDecayAt ?? 0),
    enabledSources: uniqueStrings(left.enabledSources, right.enabledSources),
    disabledSourceIds: uniqueStrings(left.disabledSourceIds, right.disabledSourceIds),
    enabledTopics:
      left.enabledTopics.length === 0 || (right.enabledTopics?.length ?? 0) === 0
        ? []
        : uniqueStrings(left.enabledTopics, right.enabledTopics) as Topic[],
    customSources: mergeById(left.customSources, right.customSources ?? []),
    userLabels: mergeById(left.userLabels, right.userLabels ?? []),
  };
}

function dedupeTagList(tags: string[]): string[] {
  return Array.from(new Set(tags.map(t => t.trim().toLowerCase()).filter(Boolean)));
}

export function mergeArticleTags(left: ArticleTag[], right: ArticleTag[]): ArticleTag[] {
  const byId = new Map(left.map(t => [t.articleId, { ...t, tags: dedupeTagList(t.tags) }]));
  for (const tag of right) {
    const normalized = { ...tag, tags: dedupeTagList(tag.tags) };
    const prev = byId.get(tag.articleId);
    if (!prev || normalized.taggedAt >= prev.taggedAt) byId.set(normalized.articleId, normalized);
  }
  return Array.from(byId.values());
}

export function mergeLabelHits(left: LabelHit[], right: LabelHit[]): LabelHit[] {
  const byKey = new Map(left.map(h => [`${h.labelId}:${h.articleId}`, h]));
  for (const hit of right) {
    const key = `${hit.labelId}:${hit.articleId}`;
    const prev = byKey.get(key);
    if (!prev || hit.classifiedAt >= prev.classifiedAt) byKey.set(key, hit);
  }
  return Array.from(byKey.values());
}

export function parseSyncHash(): Partial<SyncPayloadV1> | null {
  if (typeof location === 'undefined') return null;
  const hash = location.hash;
  if (isSyncDebugEnabled()) {
    console.info(SYNC_LOG, 'checking location hash', {
      hasHash: hash.length > 0,
      isSyncHash: hash.startsWith('#sync='),
      hashLength: hash.length,
    });
  }
  try {
    if (hash.startsWith('#sync=')) {
      const parsed = JSON.parse(fromBase64Url(hash.slice('#sync='.length))) as Partial<SyncPayloadV1>;
      if (parsed?.v !== 1) {
        console.warn(SYNC_LOG, 'unsupported sync payload', { version: parsed?.v });
        return null;
      }
      console.info(SYNC_LOG, 'parsed sync payload', {
        savedArticles: parsed.savedArticles?.length ?? 0,
        articleTags: parsed.articleTags?.length ?? 0,
        labelHits: parsed.labelHits?.length ?? 0,
        savedIds: parsed.prefs?.savedIds?.length ?? 0,
        userLabels: parsed.prefs?.userLabels?.length ?? 0,
        customSources: parsed.prefs?.customSources?.length ?? 0,
      });
      return parsed;
    }
  } catch (e) {
    console.warn(SYNC_LOG, 'failed to parse sync payload', e);
    return null;
  }
  return null;
}

