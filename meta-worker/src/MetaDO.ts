const MAX_MISSED_PONGS = 2;

interface SessionState {
  missedPongs: number;
  subscribedIds: Set<string>;
}

export class MetaDO implements DurableObject {
  private sessions = new Map<WebSocket, SessionState>();

  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    this.state.acceptWebSocket(server);
    this.sessions.set(server, { missedPongs: 0, subscribedIds: new Set() });
    server.send(JSON.stringify({ type: 'welcome' }));

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketOpen(ws: WebSocket): void {
    // Called on hibernation wake for existing connections that were hibernated.
    // First-connect welcome is sent from fetch() above.
    if (!this.sessions.has(ws)) {
      this.sessions.set(ws, { missedPongs: 0, subscribedIds: new Set() });
      ws.send(JSON.stringify({ type: 'welcome' }));
    }
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const session = this.sessions.get(ws);
    if (!session) return;

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
    _ws: WebSocket,
    _session: SessionState,
    _msg: Record<string, unknown>,
  ): void {
    // Extended in later slices
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
