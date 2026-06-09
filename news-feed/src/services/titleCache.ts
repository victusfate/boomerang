import { kvGet, kvSet } from './kvStore';

const KEY = 'rec:title-cache:v1';
const MAX_ENTRIES = 1000;

// Chain writes: saveTitles is called per render batch and a concurrent
// read-modify-write would drop entries.
let writeChain: Promise<void> = Promise.resolve();

export function saveTitles(articles: { id: string; title: string }[]): Promise<void> {
  if (articles.length === 0) return Promise.resolve();
  writeChain = writeChain.catch(() => {}).then(() => saveTitlesNow(articles));
  return writeChain;
}

async function saveTitlesNow(articles: { id: string; title: string }[]): Promise<void> {
  const cache = await kvGet<Record<string, string>>(KEY) ?? {};
  // Delete-then-set so re-saved ids move to the end — eviction below stays LRU-ish.
  for (const a of articles) {
    delete cache[a.id];
    cache[a.id] = a.title;
  }
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
