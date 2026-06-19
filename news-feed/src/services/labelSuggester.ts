import { isPromptApiAvailable } from './labelClassifier.ts';
import type { Article, UserPrefs } from '../types';

const MAX_LABEL_LENGTH    = 60;
const MAX_LABELS_RETURNED = 5;
const TOPIC_BOOST_THRESHOLD = 1.2; // minimum learned weight to surface a topic as a suggestion
const MAX_TOP_KEYWORDS    = 15;
const MAX_UPVOTED_TITLES  = 10;

export function parseLabels(text: string): string[] {
  return text
    .split('\n')
    .map(l => l.trim().replace(/^[-*•\d.]+\s*/, ''))
    .filter(l => l.length > 0 && l.length <= MAX_LABEL_LENGTH)
    .slice(0, MAX_LABELS_RETURNED);
}

export async function suggestLabels(
  prefs: UserPrefs,
  articles: Article[],
): Promise<string[]> {
  if (!isPromptApiAvailable()) return [];

  const topTopics = Object.entries(prefs.topicWeights)
    .filter(([, w]) => w > TOPIC_BOOST_THRESHOLD)
    .map(([t]) => t)
    .join(', ') || 'general';

  const topKeywords = Object.entries(prefs.keywordWeights)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TOP_KEYWORDS)
    .map(([k]) => k)
    .join(', ');

  const upvotedSet = new Set(prefs.upvotedIds);
  const upvotedTitles = articles
    .filter(a => upvotedSet.has(a.id))
    .slice(0, MAX_UPVOTED_TITLES)
    .map(a => a.title)
    .join('\n');

  const existingLabels = (prefs.userLabels ?? []).map(l => l.name).join(', ');

  const lines = [
    `Preferred topics: ${topTopics}`,
    topKeywords ? `Interested keywords: ${topKeywords}` : '',
    upvotedTitles ? `Upvoted articles:\n${upvotedTitles}` : '',
    existingLabels ? `Existing labels (skip these): ${existingLabels}` : '',
    '',
    'Suggest 3 to 5 concise topic label names. Return ONLY a newline-separated list, no explanation.',
  ].filter(Boolean).join('\n');

  const session = await (globalThis as any).LanguageModel.create({
    systemPrompt: 'You are a news interest analyst. Return only newline-separated label names.',
  });
  const response = await session.prompt(lines);
  return parseLabels(response);
}
