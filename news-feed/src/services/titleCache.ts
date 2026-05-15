import { kvGet, kvSet } from './kvStore';

const KEY = 'rec:title-cache:v1';
const MAX_ENTRIES = 1000;

export async function saveTitles(articles: { id: string; title: string }[]): Promise<void> {
  if (articles.length === 0) return;
  const cache = await kvGet<Record<string, string>>(KEY) ?? {};
  for (const a of articles) cache[a.id] = a.title;
  const keys = Object.keys(cache);
  if (keys.length > MAX_ENTRIES) {
    const trimmed: Record<string, string> = {};
    for (const k of keys.slice(keys.length - MAX_ENTRIES)) trimmed[k] = cache[k];
    await kvSet(KEY, trimmed);
  } else {
    await kvSet(KEY, cache);
  }
}

export async function loadTitleCache(): Promise<Record<string, string>> {
  return await kvGet<Record<string, string>>(KEY) ?? {};
}
