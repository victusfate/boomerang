export type SearchScope = 'all' | 'feed' | 'queue' | 'history';

export interface SearchCandidate {
  id: string;
  title: string;
  url: string;
  source: string;
  sourceId: string;
  publishedAt: string;
  inPool: boolean;
  inQueue: boolean;
}

const RANK_PREFIX = 1;
const RANK_WORD_PREFIX = 2;
const RANK_SUBSTRING = 3;
type MatchRank = 1 | 2 | 3;

function matchRank(text: string, q: string): MatchRank | null {
  const t = text.toLowerCase();
  if (t.startsWith(q)) return RANK_PREFIX;
  if (t.split(/\s+/).some(word => word.startsWith(q))) return RANK_WORD_PREFIX;
  if (t.includes(q)) return RANK_SUBSTRING;
  return null;
}

function scopeFilter(c: SearchCandidate, scope: SearchScope): boolean {
  if (scope === 'feed') return c.inPool && !c.inQueue;
  if (scope === 'queue') return c.inQueue;
  if (scope === 'history') return !c.inPool && !c.inQueue;
  return true; // 'all'
}

export function searchArticles(
  query: string,
  candidates: SearchCandidate[],
  scope: SearchScope,
): SearchCandidate[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  // Deduplicate: pool entry wins over history entry for same id
  const seen = new Map<string, SearchCandidate>();
  for (const c of candidates) {
    const existing = seen.get(c.id);
    if (!existing || c.inPool) seen.set(c.id, c);
  }

  type Ranked = { candidate: SearchCandidate; rank: MatchRank };
  const ranked: Ranked[] = [];

  for (const c of seen.values()) {
    if (!scopeFilter(c, scope)) continue;
    const titleRank = matchRank(c.title, q);
    const sourceRank = matchRank(c.source, q);
    const best = titleRank !== null && sourceRank !== null
      ? Math.min(titleRank, sourceRank) as MatchRank
      : titleRank ?? sourceRank;
    if (best !== null) ranked.push({ candidate: c, rank: best });
  }

  return ranked
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return b.candidate.publishedAt.localeCompare(a.candidate.publishedAt);
    })
    .map(r => r.candidate);
}
