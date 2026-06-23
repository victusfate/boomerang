import type { CaptureRecord } from '../types.ts';

const META_SUFFIX = '/meta';
const MAX_ATTEMPTS = 2;
const CONTENT_TYPE = 'application/json';

interface StoredCaptureArticle {
  id: string;
  title: string;
  url: string;
  description: string;
  publishedAt: string;
  source: string;
  sourceId: string;
  topics: string[];
}

interface SavedListPrefs {
  savedIds?: string[];
  savedAtById?: Record<string, number>;
  [key: string]: unknown;
}

interface SavedListPayload {
  v?: number;
  prefs?: SavedListPrefs;
  savedArticles?: StoredCaptureArticle[];
  [key: string]: unknown;
}

function storedArticle(capture: CaptureRecord): StoredCaptureArticle {
  return {
    id: capture.id,
    title: capture.title || capture.url,
    url: capture.url,
    description: capture.note || '',
    publishedAt: capture.ts,
    source: 'Capture',
    sourceId: 'capture',
    topics: ['general'],
  };
}

function appendInto(payload: SavedListPayload, capture: CaptureRecord): void {
  const prefs: SavedListPrefs = payload.prefs ?? {};
  prefs.savedIds = [capture.id, ...(prefs.savedIds ?? [])];
  prefs.savedAtById = { ...(prefs.savedAtById ?? {}), [capture.id]: Date.parse(capture.ts) };
  payload.prefs = prefs;
  payload.savedArticles = [storedArticle(capture), ...(payload.savedArticles ?? [])];
}

function freshPayload(capture: CaptureRecord): SavedListPayload {
  const payload: SavedListPayload = { v: 1, savedArticles: [], articleTags: [], labelHits: [] };
  appendInto(payload, capture);
  return payload;
}

export async function appendToSavedList(r2: R2Bucket, roomId: string, capture: CaptureRecord): Promise<void> {
  const key = roomId + META_SUFFIX;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const existing = await r2.get(key);
    if (!existing) {
      await r2.put(key, JSON.stringify(freshPayload(capture)), { httpMetadata: { contentType: CONTENT_TYPE } });
      return;
    }
    const payload = JSON.parse(await existing.text()) as SavedListPayload;
    appendInto(payload, capture);
    const put = await r2.put(key, JSON.stringify(payload), {
      httpMetadata: { contentType: CONTENT_TYPE },
      onlyIf: { etagMatches: existing.etag },
    });
    if (put !== null) return;
  }
  console.warn('[capture] saved-list append dropped after conflict', { roomId, id: capture.id });
}
