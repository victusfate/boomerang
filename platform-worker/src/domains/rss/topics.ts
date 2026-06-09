import type { Topic } from './sources';

const TOPIC_KEYWORDS: Record<Topic, string[]> = {
  technology:   ['tech', 'software', 'ai', 'artificial intelligence', 'startup', 'computer', 'app', 'digital', 'cyber', 'robot', 'algorithm', 'data', 'cloud', 'code', 'developer', 'open source', 'programming', 'silicon', 'apple', 'google', 'microsoft', 'openai', 'llm', 'model'],
  science:      ['science', 'research', 'study', 'scientists', 'discovery', 'space', 'nasa', 'biology', 'physics', 'chemistry', 'genome', 'dna', 'evolution', 'universe', 'quantum', 'experiment'],
  world:        ['war', 'election', 'government', 'president', 'country', 'international', 'global', 'politics', 'diplomatic', 'treaty', 'sanctions', 'military', 'conflict', 'nato', 'un', 'china', 'russia', 'europe'],
  business:     ['economy', 'market', 'stock', 'financial', 'business', 'trade', 'bank', 'investment', 'gdp', 'inflation', 'revenue', 'profit', 'merger', 'acquisition', 'ipo', 'venture', 'funding'],
  health:       ['health', 'medical', 'vaccine', 'disease', 'hospital', 'doctor', 'treatment', 'cancer', 'mental health', 'drug', 'clinical', 'patient', 'fda', 'cdc', 'pandemic'],
  environment:  ['climate', 'environment', 'carbon', 'emissions', 'renewable', 'solar', 'wind', 'fossil fuel', 'biodiversity', 'ocean', 'deforestation', 'sustainability', 'green'],
  sports:       ['sports', 'football', 'basketball', 'baseball', 'soccer', 'tennis', 'nba', 'nfl', 'olympic', 'championship', 'tournament', 'athlete', 'league', 'fifa'],
  entertainment:['movie', 'film', 'music', 'album', 'celebrity', 'award', 'oscar', 'grammy', 'streaming', 'netflix', 'disney', 'hollywood', 'concert', 'box office'],
  general:      [],
};

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Keywords match at word boundaries — bare substring matching mis-tagged a
 * large share of articles ('un' in "under", 'ai' in "rain", 'app' in
 * "happen"). Short keywords (≤3 chars) require a whole word; longer ones
 * match as word prefixes so 'green' still hits "greenhouse" and 'code' hits
 * "codebase".
 */
const TOPIC_PATTERNS: Array<[Topic, RegExp]> = (
  Object.entries(TOPIC_KEYWORDS) as [Topic, string[]][]
)
  .filter(([topic, keywords]) => topic !== 'general' && keywords.length > 0)
  .map(([topic, keywords]) => {
    const parts = keywords.map(kw =>
      kw.length <= 3 ? `\\b${escapeRe(kw)}\\b` : `\\b${escapeRe(kw)}`,
    );
    return [topic, new RegExp(parts.join('|'), 'i')];
  });

export function detectTopics(text: string): Topic[] {
  const matched: Topic[] = [];
  for (const [topic, pattern] of TOPIC_PATTERNS) {
    if (pattern.test(text)) matched.push(topic);
  }
  return matched.length > 0 ? matched.slice(0, 3) : ['general'];
}
