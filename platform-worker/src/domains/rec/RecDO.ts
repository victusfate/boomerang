import { RecDO as BaseRecDO } from '@victusfate/ricochet/worker';
import type { RecWorkerEnv } from '@victusfate/ricochet/worker';

const REC_FEED_POOL_CACHE_TTL_MS = 2 * 60 * 1_000;   // 2 min — per candidate-set
const REC_GLOBAL_CACHE_TTL_MS    = 5 * 60 * 1_000;   // 5 min — matches ricochet internal

interface RankingCacheEntry extends Record<string, SqlStorageValue> {
  payload:    string;
  expires_at: number;
}

async function poolHash(ids: string[]): Promise<string> {
  const sorted = [...ids].sort();
  const encoded = new TextEncoder().encode(sorted.join(','));
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest))
    .slice(0, 12)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function makeCacheKey(userId: string, limit: number, candidateIds?: string[]): Promise<string> {
  if (!candidateIds) return `recs:${userId}:global:${limit}`;
  const hash = await poolHash(candidateIds);
  return `recs:${userId}:pool:${hash}:${limit}`;
}

/**
 * Extends the ricochet RecDO with a DO-local SQLite `ranking_cache` table.
 * Zero KV quota consumption — all ranking results cached in Durable Object storage.
 */
export class RecDO extends BaseRecDO {
  constructor(state: DurableObjectState, env: RecWorkerEnv) {
    super(state, env);
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS ranking_cache (
        cache_key  TEXT    PRIMARY KEY,
        payload    TEXT    NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const recsMatch = url.pathname.match(/^\/recs\/(.+)$/);

    if (recsMatch && (request.method === 'GET' || request.method === 'POST')) {
      return this._handleRecs(request, url, recsMatch[1]);
    }

    if (url.pathname === '/prune' && request.method === 'POST') {
      this.state.storage.sql.exec(
        `DELETE FROM ranking_cache WHERE expires_at <= ?`,
        Date.now(),
      );
      return super.fetch(request);
    }

    if (url.pathname === '/debug/rank-cache-count' && request.method === 'GET') {
      type CountRow = { count: number };
      const [row] = [...this.state.storage.sql.exec<CountRow>(
        `SELECT COUNT(*) AS count FROM ranking_cache WHERE expires_at > ?`,
        Date.now(),
      )];
      return Response.json({ activeCacheEntries: row?.count ?? 0 });
    }

    return super.fetch(request);
  }

  private async _handleRecs(request: Request, url: URL, encodedUserId: string): Promise<Response> {
    const userId = decodeURIComponent(encodedUserId);
    const limitParam = url.searchParams.get('limit');
    let limit = 50;
    if (limitParam) {
      const p = parseInt(limitParam, 10);
      if (!Number.isNaN(p)) limit = Math.max(1, Math.min(500, p));
    }

    let candidateIds: string[] | undefined;
    let hasTopicWeights = false;
    let bodyText: string | undefined;

    if (request.method === 'POST') {
      bodyText = await request.text();
      try {
        const body = JSON.parse(bodyText) as { candidateArticleIds?: unknown; limit?: unknown; topicWeights?: unknown };
        if (Array.isArray(body.candidateArticleIds)) {
          candidateIds = (body.candidateArticleIds as unknown[])
            .filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
        }
        if (body.limit !== undefined) {
          const p = typeof body.limit === 'number' ? body.limit : parseInt(String(body.limit), 10);
          if (!Number.isNaN(p)) limit = Math.max(1, Math.min(500, p));
        }
        // topicWeights bypass: personalised weights must not share a cache entry with
        // unweighted or differently-weighted requests for the same candidate set.
        hasTopicWeights = body.topicWeights !== undefined && body.topicWeights !== null
          && typeof body.topicWeights === 'object' && !Array.isArray(body.topicWeights);
      } catch {
        // invalid JSON — let super handle the 400
        return super.fetch(new Request(request.url, {
          method: 'POST',
          headers: request.headers,
          body: bodyText,
        }));
      }
    } else {
      const raw = url.searchParams.get('candidates');
      if (raw !== null) {
        candidateIds = raw.split(',').map(s => s.trim()).filter(Boolean);
      }
    }

    // Bypass SQLite cache when topicWeights are present — mirrors ricochet's KV cache bypass.
    if (hasTopicWeights) {
      const baseReq = new Request(request.url, { method: 'POST', headers: request.headers, body: bodyText });
      return super.fetch(baseReq);
    }

    const cacheKey = await makeCacheKey(userId, limit, candidateIds);
    const now = Date.now();

    const [cached] = [...this.state.storage.sql.exec<RankingCacheEntry>(
      `SELECT payload, expires_at FROM ranking_cache WHERE cache_key = ? AND expires_at > ?`,
      cacheKey,
      now,
    )];

    if (cached) {
      return new Response(cached.payload, {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Cache miss — forward to base RecDO
    const baseReq = request.method === 'POST'
      ? new Request(request.url, { method: 'POST', headers: request.headers, body: bodyText })
      : request;

    const baseRes = await super.fetch(baseReq);
    if (!baseRes.ok) return baseRes;

    const payload = await baseRes.text();
    const ttlMs = candidateIds !== undefined ? REC_FEED_POOL_CACHE_TTL_MS : REC_GLOBAL_CACHE_TTL_MS;

    this.state.storage.sql.exec(
      `INSERT OR REPLACE INTO ranking_cache (cache_key, payload, expires_at) VALUES (?, ?, ?)`,
      cacheKey,
      payload,
      now + ttlMs,
    );

    return new Response(payload, { headers: { 'Content-Type': 'application/json' } });
  }
}
