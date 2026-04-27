import { isPromptApiAvailable } from './labelClassifier.ts';
import type { Article, UserPrefs } from '../types';

export function parseLabels(text: string): string[] {
  return text
    .split('\n')
    .map(l => l.trim().replace(/^[-*•\d.]+\s*/, ''))
    .filter(l => l.length > 0 && l.length <= 60)
    .slice(0, 5);
}

export async function suggestLabels(
  prefs: UserPrefs,
  articles: Article[],
): Promise<string[]> {
  if (!isPromptApiAvailable()) return [];

  const topTopics = Object.entries(prefs.topicWeights)
    .filter(([, w]) => w > 1.2)
    .map(([t]) => t)
    .join(', ') || 'general';

  const topKeywords = Object.entries(prefs.keywordWeights)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([k]) => k)
    .join(', ');

  const upvotedSet = new Set(prefs.upvotedIds);
  const upvotedTitles = articles
    .filter(a => upvotedSet.has(a.id))
    .slice(0, 10)
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
