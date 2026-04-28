import { DEFAULT_PREFS } from './storage';
import type { Article, ArticleTag, LabelHit, Topic, UserPrefs } from '../types';

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

function toBase64Url(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
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

export function mergePrefs(left: UserPrefs, right: Partial<UserPrefs>): UserPrefs {
  return {
    ...left,
    topicWeights:   { ...left.topicWeights, ...(right.topicWeights ?? {}) },
    sourceWeights:  { ...left.sourceWeights, ...(right.sourceWeights ?? {}) },
    keywordWeights: { ...left.keywordWeights, ...(right.keywordWeights ?? {}) },
    readIds:        uniqueStrings(left.readIds, right.readIds),
    savedIds:       uniqueStrings(left.savedIds, right.savedIds),
    seenIds:        uniqueStrings(left.seenIds, right.seenIds),
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

export function mergeArticlesById(left: Article[], right: Article[]): Article[] {
  return Array.from(new Map([...left, ...right].map(a => [a.id, a])).values());
}

export function mergeArticleTags(left: ArticleTag[], right: ArticleTag[]): ArticleTag[] {
  const byId = new Map(left.map(t => [t.articleId, t]));
  for (const tag of right) {
    const prev = byId.get(tag.articleId);
    if (!prev || tag.taggedAt >= prev.taggedAt) byId.set(tag.articleId, tag);
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
  console.info(SYNC_LOG, 'checking location hash', {
    hasHash: hash.length > 0,
    isSyncHash: hash.startsWith('#sync='),
    hashLength: hash.length,
  });
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

export function buildSyncShareUrl(
  prefs: UserPrefs,
  savedArticles: Article[],
  articleTags: ArticleTag[],
  labelHits: LabelHit[],
): string {
  if (typeof location === 'undefined') return '';
  const payload: SyncPayloadV1 = {
    v: 1,
    prefs: { ...DEFAULT_PREFS, ...prefs },
    savedArticles: dehydrate(savedArticles),
    articleTags,
    labelHits,
  };
  const encoded = toBase64Url(JSON.stringify(payload));
  console.info(SYNC_LOG, 'built sync link payload', {
    savedArticles: payload.savedArticles.length,
    articleTags: payload.articleTags.length,
    labelHits: payload.labelHits.length,
    savedIds: payload.prefs.savedIds.length,
    userLabels: payload.prefs.userLabels.length,
    customSources: payload.prefs.customSources.length,
    encodedLength: encoded.length,
  });
  return `${location.origin}${location.pathname}#sync=${encoded}`;
}
