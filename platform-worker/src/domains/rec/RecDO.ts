import { RecDO as BaseRecDO } from '@victusfate/ricochet/worker';
import type { RecCoreResponse, ScoredArticle } from '@victusfate/ricochet';

const MF_NFACTORS = 10; // matches DEFAULT_MF_PARAMS.nFactors in ricochet

type ScoreResult = { ranked: ScoredArticle[]; excludedDownvotes: number; coldStart: boolean };
type RecDOWithScore = BaseRecDO & { score(userId: string, candidateIds: string[]): ScoreResult };

/** Extended RecDO that adds POST /recs/:userId with candidateArticleIds for feed-pool ranking. */
export class RecDO extends BaseRecDO {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const recsMatch = url.pathname.match(/^\/recs\/(.+)$/);

    if (recsMatch && request.method === 'POST') {
      const userId = decodeURIComponent(recsMatch[1]);
      let body: { candidateArticleIds?: unknown; limit?: unknown };
      try {
        body = await request.json() as typeof body;
      } catch {
        return new Response('Invalid JSON', { status: 400 });
      }

      const candidateIds = Array.isArray(body.candidateArticleIds)
        ? body.candidateArticleIds.filter((id): id is string => typeof id === 'string')
        : [];
      const rawLimit = body.limit;
      const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit)
        ? Math.max(1, Math.trunc(rawLimit))
        : 50;

      const scored = (this as unknown as RecDOWithScore).score(userId, candidateIds);
      const topScored = scored.ranked.slice(0, limit);

      const response: RecCoreResponse = {
        articleIds: topScored.map((r) => r.articleId),
        generatedAt: Date.now(),
        scoredArticleIds: topScored,
        diagnostics: {
          model: 'biased-mf',
          modelVersion: 'v1',
          factorCount: MF_NFACTORS,
          candidateCount: candidateIds.length,
          rankedCount: scored.ranked.length,
          returnedCount: topScored.length,
          excludedDownvotes: scored.excludedDownvotes,
          coldStart: scored.coldStart,
          limit,
        },
      };

      return new Response(JSON.stringify(response), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return super.fetch(request);
  }
}
