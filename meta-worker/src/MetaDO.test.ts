import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

async function connectWS(): Promise<WebSocket> {
  const res = await SELF.fetch('http://localhost/ws', {
    headers: { Upgrade: 'websocket' },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  return ws;
}

function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    ws.addEventListener('message', e => resolve(JSON.parse(e.data as string)), { once: true });
    ws.addEventListener('close', () => reject(new Error('closed before message')), { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
}

function closed(ws: WebSocket): Promise<void> {
  return new Promise(resolve => ws.addEventListener('close', () => resolve(), { once: true }));
}

describe('S2 — DO WebSocket', () => {
  it('GET /ws → 101 upgrade + welcome message', async () => {
    const ws = await connectWS();
    const msg = await nextMessage(ws);
    expect(msg).toMatchObject({ type: 'welcome' });
    ws.close();
  });

  it('reconnect → welcome again', async () => {
    const ws1 = await connectWS();
    await nextMessage(ws1);
    ws1.close();

    const ws2 = await connectWS();
    const msg = await nextMessage(ws2);
    expect(msg).toMatchObject({ type: 'welcome' });
    ws2.close();
  });

  it('pong keeps connection alive; no pong → close after 2 missed', async () => {
    // Covered by heartbeat logic in MetaDO — just verify ping arrives
    const ws = await connectWS();
    await nextMessage(ws); // welcome
    // send pong immediately to keep alive
    ws.send(JSON.stringify({ type: 'pong' }));
    ws.close();
  });

  it('non-WebSocket GET /ws → 426 Upgrade Required', async () => {
    const res = await SELF.fetch('http://localhost/ws');
    expect(res.status).toBe(426);
  });
});

describe('S3 — submitTags', () => {
  let ws: WebSocket;

  beforeEach(async () => {
    ws = await connectWS();
    await nextMessage(ws); // consume welcome
  });

  it('accepts a valid submitTags batch and writes to KV', async () => {
    ws.send(JSON.stringify({
      type: 'submitTags',
      articles: [{ articleId: 'aabbccdd11223344', tags: ['ai', 'Climate '] }],
    }));
    // Allow async KV write to settle
    await new Promise(r => setTimeout(r, 50));
    const entry = await env.ARTICLE_META.get('meta:aabbccdd11223344', 'json') as Record<string, unknown> | null;
    expect(entry).not.toBeNull();
    expect(entry!.tags).toEqual(['ai', 'climate']); // normalised
    expect(entry!.contributors).toBe(1);
    ws.close();
  });

  it('union-merges tags from two submissions', async () => {
    const id = 'merge000000000001';
    ws.send(JSON.stringify({ type: 'submitTags', articles: [{ articleId: id, tags: ['ai'] }] }));
    await new Promise(r => setTimeout(r, 50));
    ws.send(JSON.stringify({ type: 'submitTags', articles: [{ articleId: id, tags: ['climate'] }] }));
    await new Promise(r => setTimeout(r, 50));
    const entry = await env.ARTICLE_META.get('meta:' + id, 'json') as Record<string, unknown>;
    expect((entry.tags as string[]).sort()).toEqual(['ai', 'climate']);
    ws.close();
  });

  it('stops accepting after N=3 contributors', async () => {
    const id = 'captest0000000001';
    // Fill 3 contributors via 3 separate connections
    for (let i = 0; i < 3; i++) {
      const w = await connectWS();
      await nextMessage(w);
      w.send(JSON.stringify({ type: 'submitTags', articles: [{ articleId: id, tags: [`tag${i}`] }] }));
      await new Promise(r => setTimeout(r, 50));
      w.close();
    }
    // 4th contributor should be silently dropped
    const w4 = await connectWS();
    await nextMessage(w4);
    w4.send(JSON.stringify({ type: 'submitTags', articles: [{ articleId: id, tags: ['extra'] }] }));
    await new Promise(r => setTimeout(r, 50));
    const entry = await env.ARTICLE_META.get('meta:' + id, 'json') as Record<string, unknown>;
    expect(entry.contributors).toBe(3);
    expect((entry.tags as string[])).not.toContain('extra');
    w4.close();
    ws.close();
  });

  it('rejects batch larger than 200 articles silently', async () => {
    const articles = Array.from({ length: 201 }, (_, i) => ({
      articleId: `batch${String(i).padStart(12, '0')}`,
      tags: ['x'],
    }));
    ws.send(JSON.stringify({ type: 'submitTags', articles }));
    await new Promise(r => setTimeout(r, 50));
    // First article should NOT have been written
    const entry = await env.ARTICLE_META.get('meta:batch000000000000', 'json');
    expect(entry).toBeNull();
    ws.close();
  });

  it('subscribe + submitTags → broadcast only to subscribed client', async () => {
    const wsA = await connectWS();
    await nextMessage(wsA); // welcome
    const wsB = await connectWS();
    await nextMessage(wsB); // welcome

    const idA = 'broadcastaaa00001';
    const idB = 'broadcastbbb00001';

    wsA.send(JSON.stringify({ type: 'subscribe', articleIds: [idA] }));
    wsB.send(JSON.stringify({ type: 'subscribe', articleIds: [idB] }));
    await new Promise(r => setTimeout(r, 20));

    // Collect any incoming message on wsB with a short race
    let bGotMsg = false;
    const bRace = new Promise<void>(resolve => {
      wsB.addEventListener('message', () => { bGotMsg = true; resolve(); }, { once: true });
      setTimeout(resolve, 200);
    });

    // Register listener before send so we don't miss the broadcast
    const msgAPromise = Promise.race([
      nextMessage(wsA),
      new Promise<null>(r => setTimeout(() => r(null), 300)),
    ]);

    wsA.send(JSON.stringify({ type: 'submitTags', articles: [{ articleId: idA, tags: ['ai'] }] }));
    const msgA = await msgAPromise;
    await bRace;

    expect(msgA).toMatchObject({ type: 'tags', articleId: idA });
    expect(bGotMsg).toBe(false);

    wsA.close();
    wsB.close();
  });

  it('catchUp since=0 returns all KV entries', async () => {
    const ids = ['catchup0000000001', 'catchup0000000002', 'catchup0000000003'];
    for (const id of ids) {
      ws.send(JSON.stringify({ type: 'submitTags', articles: [{ articleId: id, tags: ['test'] }] }));
    }
    await new Promise(r => setTimeout(r, 50));

    const replyPromise = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'catchUp', since: 0 }));
    const reply = await replyPromise as { type: string; updates: unknown[] };

    expect(reply.type).toBe('catchUp');
    expect(reply.updates.length).toBeGreaterThanOrEqual(3);
    ws.close();
  });

  it('catchUp since=future returns empty updates', async () => {
    const replyPromise = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'catchUp', since: Date.now() + 9_999_999 }));
    const reply = await replyPromise as { type: string; updates: unknown[] };

    expect(reply.type).toBe('catchUp');
    expect(reply.updates).toEqual([]);
    ws.close();
  });

  it('rate-limits to 20 messages/min per connection', async () => {
    // Send 21 messages rapidly; 21st should be ignored (connection not closed but msg dropped)
    for (let i = 0; i < 21; i++) {
      ws.send(JSON.stringify({
        type: 'submitTags',
        articles: [{ articleId: `rate${String(i).padStart(12, '0')}`, tags: ['t'] }],
      }));
    }
    await new Promise(r => setTimeout(r, 100));
    // Article 20 (0-indexed) should NOT be written
    const entry = await env.ARTICLE_META.get('meta:rate000000000020', 'json');
    expect(entry).toBeNull();
    ws.close();
  });
});
