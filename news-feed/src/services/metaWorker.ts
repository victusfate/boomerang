export function metaWorkerWsUrl(base: string): string {
  return base.replace(/^http/, 'ws') + '/ws';
}

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

function parseRetryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get('Retry-After');
  if (!raw) return undefined;
  const asSeconds = Number(raw);
  if (Number.isFinite(asSeconds)) return Math.max(0, Math.round(asSeconds * 1000));
  const asDate = Date.parse(raw);
  if (Number.isNaN(asDate)) return undefined;
  return Math.max(0, asDate - Date.now());
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

// Client → DO
export interface SubscribeMsg   { type: 'subscribe'; articleIds: string[] }
export interface CatchUpMsg     { type: 'catchUp'; since: number; before?: number }
export interface SubmitTagsMsg  { type: 'submitTags'; articles: Array<{ articleId: string; tags: string[] }> }
export interface PongMsg        { type: 'pong' }
export type ClientMsg = SubscribeMsg | CatchUpMsg | SubmitTagsMsg | PongMsg;

// DO → Client
export interface WelcomeMsg  { type: 'welcome' }
export interface PingMsg     { type: 'ping' }
export interface TagsMsg     { type: 'tags'; articleId: string; tags: string[]; updatedAt: number }
export interface CatchUpReplyMsg { type: 'catchUp'; updates: Array<{ articleId: string; tags: string[]; updatedAt: number }>; hasMore?: boolean; cursor?: number }
export type ServerMsg = WelcomeMsg | PingMsg | TagsMsg | CatchUpReplyMsg;

export function parseServerMsg(raw: string): ServerMsg | null {
  try {
    const msg = JSON.parse(raw) as ServerMsg;
    if (typeof msg.type !== 'string') return null;
    return msg;
  } catch {
    return null;
  }
}
