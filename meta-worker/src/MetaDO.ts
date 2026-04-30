import { normaliseTags, mergeTagSets } from './tags';

const MAX_MISSED_PONGS = 2;
const MAX_BATCH_SIZE = 200;
const MAX_MSG_PER_MIN = 20;
const MAX_TAGS_PER_ARTICLE = 6;
const KV_TTL_SECONDS = 90 * 24 * 60 * 60;          // 90 days
const SQLITE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const ALARM_INTERVAL_MS = 60 * 60 * 1000;            // 1 hour
const CATCHUP_PAGE_SIZE = 200;

export interface ArticleMetaEntry {
  articleId: string;
  tags: string[];
  updatedAt: number;
}

interface SessionState {
  missedPongs: number;
  subscribedIds: Set<string>;
  msgCount: number;
  msgWindowStart: number;
}

export class MetaDO implements DurableObject {
  private sessions = new Map<WebSocket, SessionState>();

  constructor(private state: DurableObjectState, private env: Env) {
    // LRU index — tag data lives in KV; SQLite tracks recency for catchUp + alarm pruning
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS article_meta (
        article_id TEXT PRIMARY KEY,
        updated_at INTEGER NOT NULL
      )
    `);
    // Schedule hourly pruning alarm on first boot; no-op if already set
    void this.state.storage.getAlarm().then(existing => {
      if (existing === null) {
        void this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
      }
    });
  }

  async alarm(): Promise<void> {
    const cutoff = Date.now() - SQLITE_RETENTION_MS;
    this.state.storage.sql.exec(
      'DELETE FROM article_meta WHERE updated_at < ?',
      cutoff,
    );
    await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    this.state.acceptWebSocket(server);
    this.sessions.set(server, {
      missedPongs: 0,
      subscribedIds: new Set(),
      msgCount: 0,
      msgWindowStart: Date.now(),
    });
    server.send(JSON.stringify({ type: 'welcome' }));

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketOpen(ws: WebSocket): void {
    if (!this.sessions.has(ws)) {
      this.sessions.set(ws, {
        missedPongs: 0,
        subscribedIds: new Set(),
        msgCount: 0,
        msgWindowStart: Date.now(),
      });
      ws.send(JSON.stringify({ type: 'welcome' }));
    }
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const session = this.sessions.get(ws);
    if (!session) return;

    const now = Date.now();
    if (now - session.msgWindowStart >= 60_000) {
      session.msgCount = 0;
      session.msgWindowStart = now;
    }
    session.msgCount++;
    if (session.msgCount > MAX_MSG_PER_MIN) return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }

    if (msg.type === 'pong') {
      session.missedPongs = 0;
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

  ping(): void {
    for (const [ws, session] of this.sessions) {
      session.missedPongs++;
      if (session.missedPongs > MAX_MISSED_PONGS) {
        ws.close(1001, 'heartbeat timeout');
        this.sessions.delete(ws);
      } else {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }
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
    const key = `meta:${articleId}`;
    const existing = await this.env.ARTICLE_META.get<ArticleMetaEntry>(key, 'json');

    const existingTags = existing?.tags ?? [];
    const merged = mergeTagSets(existingTags, incomingTags).slice(0, MAX_TAGS_PER_ARTICLE);

    // No-op if tags are unchanged (all incoming already present and at capacity)
    if (
      merged.length === existingTags.length &&
      merged.every((t, i) => t === existingTags[i])
    ) return;

    const updatedAt = Date.now();
    const entry: ArticleMetaEntry = { articleId, tags: merged, updatedAt };

    // Primary durable store: KV with 90-day sliding TTL
    await this.env.ARTICLE_META.put(key, JSON.stringify(entry), {
      expirationTtl: KV_TTL_SECONDS,
    });

    // Hot index: SQLite tracks recency only — pruned to 14-day window by alarm
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

    // Fetch tag data from KV concurrently
    const entries = await Promise.all(
      rows.map(r => this.env.ARTICLE_META.get<ArticleMetaEntry>(`meta:${r.article_id}`, 'json')),
    );

    const updates = entries.filter((e): e is ArticleMetaEntry => e !== null);
    const hasMore = rows.length === CATCHUP_PAGE_SIZE;
    const cursor = hasMore ? rows[rows.length - 1].updated_at : undefined;

    ws.send(JSON.stringify({ type: 'catchUp', updates, hasMore, cursor }));
  }

  protected broadcast(articleId: string, tags: string[], updatedAt: number): void {
    for (const [ws, session] of this.sessions) {
      if (session.subscribedIds.has(articleId)) {
        ws.send(JSON.stringify({ type: 'tags', articleId, tags, updatedAt }));
      }
    }
  }

  protected getSessions(): Map<WebSocket, SessionState> {
    return this.sessions;
  }
}
