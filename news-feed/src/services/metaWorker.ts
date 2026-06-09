import { parseRetryAfterMs } from './retryAfter.ts';

export interface ArticleMetaEntry {
  articleId: string;
  tags: string[];
  updatedAt: number;
}

export class MetaRateLimitError extends Error {
  retryAfterMs?: number;

  constructor(retryAfterMs?: number) {
    super('meta rate limited (429)');
    this.name = 'MetaRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}



export async function fetchMetaTags(base: string, articleIds: string[]): Promise<ArticleMetaEntry[]> {
  if (articleIds.length === 0) return [];
  const ids = Array.from(new Set(articleIds));
  const url = `${base}/meta?ids=${encodeURIComponent(ids.join(','))}`;
  const res = await fetch(url);
  if (res.status === 429) throw new MetaRateLimitError(parseRetryAfterMs(res));
  if (!res.ok) throw new Error(`meta GET failed: ${res.status}`);
  const body = await res.json() as { updates?: ArticleMetaEntry[] };
  return body.updates ?? [];
}

export async function submitMetaTags(
  base: string,
  articles: Array<{ articleId: string; tags: string[] }>,
): Promise<void> {
  if (articles.length === 0) return;
  const res = await fetch(`${base}/meta/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ articles }),
  });
  if (res.status === 429) throw new MetaRateLimitError(parseRetryAfterMs(res));
  if (!res.ok) throw new Error(`meta POST failed: ${res.status}`);
}

