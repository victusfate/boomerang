import type { Env } from '../../env';
import { normaliseTags, mergeTagSets } from './tags';
import {
  type ArticleRecord,
  ARTICLE_RECORD_TTL_SECONDS,
  articleRecordKey,
} from './articleRecord';

const MAX_BATCH_SIZE = 200;
const MAX_MSG_PER_MIN = 20;
const MAX_TAGS_PER_ARTICLE = 6;
const SQLITE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const CATCHUP_PAGE_SIZE = 200;

export type ArticleMetaEntry = ArticleRecord;

interface SessionState {
  subscribedIds: Set<string>;
  msgCount: number;
  msgWindowStart: number;
}

export class MetaDO implements DurableObject {
  /**
   * In-memory view of per-socket state. The DO uses the hibernation API, so
   * this map is empty after a wake-up — always go through getSession(), which
   * rehydrates from the socket's serialized attachment.
   */
  private sessions = new Map<WebSocket, SessionState>();

  constructor(private state: DurableObjectState, private env: Env) {
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS article_meta (
        article_id TEXT PRIMARY KEY,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  prune(cutoff = Date.now() - SQLITE_RETENTION_MS): void {
    this.state.storage.sql.exec(
      'DELETE FROM article_meta WHERE updated_at < ?',
      cutoff,
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/prune' && request.method === 'POST') {
      const cutoffParam = url.searchParams.get('cutoff');
      this.prune(cutoffParam !== null ? parseInt(cutoffParam, 10) : undefined);
      return new Response(null, { status: 204 });
    }

    // HTTP tag submissions route through the DO so there is a single writer
    // for tag updates — and HTTP-submitted tags reach WS subscribers and
    // catchUp exactly like WS-submitted ones.
    if (url.pathname === '/submit-tags' && request.method === 'POST') {
      const body = await request.json().catch(() => null) as
        { articles?: Array<{ articleId: string; tags: string[] }> } | null;
      const articles = Array.isArray(body?.articles) ? body.articles : [];
      if (articles.length > MAX_BATCH_SIZE) {
        return new Response(JSON.stringify({ ok: false, message: `max ${MAX_BATCH_SIZE} articles` }), { status: 400 });
      }
      await this.processSubmitTags(articles);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    this.state.acceptWebSocket(server);
    const session: SessionState = {
      subscribedIds: new Set(),
      msgCount: 0,
      msgWindowStart: Date.now(),
    };
    this.sessions.set(server, session);
    this.persistSession(server, session);
    server.send(JSON.stringify({ type: 'welcome' }));

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Rehydrate session state from the socket attachment after hibernation. */
  private getSession(ws: WebSocket): SessionState {
    let session = this.sessions.get(ws);
    if (!session) {
      let ids: string[] = [];
      try {
        const att = ws.deserializeAttachment() as { subscribedIds?: string[] } | null;
        if (att && Array.isArray(att.subscribedIds)) ids = att.subscribedIds;
      } catch {
        // no attachment — fresh session
      }
      session = { subscribedIds: new Set(ids), msgCount: 0, msgWindowStart: Date.now() };
      this.sessions.set(ws, session);
    }
    return session;
  }

  private persistSession(ws: WebSocket, session: SessionState): void {
    try {
      ws.serializeAttachment({ subscribedIds: [...session.subscribedIds] });
    } catch {
      // attachment size limit exceeded — session survives in memory only
    }
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const session = this.getSession(ws);

    const now = Date.now();
    if (now - session.msgWindowStart >= 60_000) {
      session.msgCount = 0;
      session.msgWindowStart = now;
    }
    session.msgCount++;
    if (session.msgCount >= MAX_MSG_PER_MIN) return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }

    this.handleMessage(ws, session, msg);
  }

  webSocketClose(ws: WebSocket): void {
    this.sessions.delete(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.sessions.delete(ws);
  }

  protected handleMessage(
    ws: WebSocket,
    session: SessionState,
    msg: Record<string, unknown>,
  ): void {
    if (msg.type === 'subscribe') {
      const ids = msg.articleIds;
      if (Array.isArray(ids)) {
        session.subscribedIds = new Set(ids.filter((id): id is string => typeof id === 'string'));
        this.persistSession(ws, session);
      }
      return;
    }

    if (msg.type === 'submitTags') {
      const articles = msg.articles;
      if (!Array.isArray(articles) || articles.length > MAX_BATCH_SIZE) return;
      this.state.waitUntil(this.processSubmitTags(articles));
      return;
    }

    if (msg.type === 'catchUp') {
      const since = typeof msg.since === 'number' ? msg.since : 0;
      const before = typeof msg.before === 'number' ? msg.before : Date.now();
      this.state.waitUntil(this.handleCatchUp(ws, since, before));
      return;
    }
  }

  private async processSubmitTags(
    articles: Array<{ articleId: string; tags: string[] }>,
  ): Promise<void> {
    for (const item of articles) {
      if (typeof item.articleId !== 'string' || !Array.isArray(item.tags)) continue;
      const normalised = normaliseTags(item.tags);
      if (normalised.length === 0) continue;
      await this.kvWrite(item.articleId, normalised);
    }
  }

  private async kvWrite(articleId: string, incomingTags: string[]): Promise<void> {
    const key = articleRecordKey(articleId);
    // Known lossiness: rec's persistArticleMeta read-merge-writes catalog
    // fields on this same key. Tag writes all flow through this DO (single
    // tag writer), but a concurrent catalog write can still last-write-win;
    // both writers preserve the other's fields, so the window is one
    // read-to-put span.
    const existing = await this.env.ARTICLE_META.get<ArticleMetaEntry>(key, 'json');

    const existingTags = existing?.tags ?? [];
    const merged = mergeTagSets(existingTags, incomingTags).slice(0, MAX_TAGS_PER_ARTICLE);

    if (
      merged.length === existingTags.length &&
      merged.every((t, i) => t === existingTags[i])
    ) return;

    const updatedAt = Date.now();
    const entry: ArticleMetaEntry = {
      articleId,
      tags: merged,
      updatedAt,
      title: existing?.title,
      source: existing?.source,
      sourceId: existing?.sourceId,
      publishedAt: existing?.publishedAt,
      url: existing?.url,
    };

    await this.env.ARTICLE_META.put(key, JSON.stringify(entry), {
      expirationTtl: ARTICLE_RECORD_TTL_SECONDS,
    });

    this.state.storage.sql.exec(
      'INSERT OR REPLACE INTO article_meta (article_id, updated_at) VALUES (?, ?)',
      articleId, updatedAt,
    );

    this.broadcast(articleId, merged, updatedAt);
  }

  protected async handleCatchUp(ws: WebSocket, since: number, before: number): Promise<void> {
    type Row = { article_id: string; updated_at: number };
    const rows = [...this.state.storage.sql.exec<Row>(
      `SELECT article_id, updated_at FROM article_meta
       WHERE updated_at > ? AND updated_at < ?
       ORDER BY updated_at DESC LIMIT ?`,
      since, before, CATCHUP_PAGE_SIZE,
    )];

    const entries = await Promise.all(
      rows.map(r => this.env.ARTICLE_META.get<ArticleMetaEntry>(articleRecordKey(r.article_id), 'json')),
    );

    const updates = entries.filter((e): e is ArticleMetaEntry => e !== null);
    const hasMore = rows.length === CATCHUP_PAGE_SIZE;
    const cursor = hasMore ? rows[rows.length - 1].updated_at : undefined;

    try {
      ws.send(JSON.stringify({ type: 'catchUp', updates, hasMore, cursor }));
    } catch {
      this.sessions.delete(ws);
    }
  }

  protected broadcast(articleId: string, tags: string[], updatedAt: number): void {
    // Iterate the runtime's socket list, not the in-memory map — after
    // hibernation the map is empty while sockets are still connected.
    for (const ws of this.state.getWebSockets()) {
      const session = this.getSession(ws);
      if (!session.subscribedIds.has(articleId)) continue;
      try {
        ws.send(JSON.stringify({ type: 'tags', articleId, tags, updatedAt }));
      } catch {
        // closed socket — drop its session; runtime fires webSocketClose separately
        this.sessions.delete(ws);
      }
    }
  }
}
