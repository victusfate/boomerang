import type { Article, ArticleTag, LabelHit, UserLabel } from '../types';

export interface LMSession {
  prompt(text: string): Promise<string>;
}

export function isPromptApiAvailable(): boolean {
  return typeof (globalThis as any).LanguageModel !== 'undefined';
}

export async function classifyArticle(
  article: Article,
  label: UserLabel,
  session: LMSession,
): Promise<boolean> {
  const text = `${article.title}. ${article.description}`.slice(0, 400);
  const response = await session.prompt(
    `Does this article relate to "${label.name}"? Answer YES or NO only.\n\n${text}`,
  );
  return response.trim().toUpperCase().startsWith('YES');
}

export async function tagArticle(
  article: Article,
  existingTags: string[],
  session: LMSession,
): Promise<string[]> {
  const context = existingTags.length > 0
    ? `Tags already in use (reuse these when relevant): ${existingTags.slice(0, 40).join(', ')}\n\n`
    : '';
  const text = `${article.title}. ${article.description}`.slice(0, 500);
  const response = await session.prompt(
    `${context}Tag this article with 2-4 concise topic tags. Prefer existing tags when appropriate. Return only a comma-separated list, no explanation.\n\n${text}`,
  );
  return response
    .split(',')
    .map(t => t.trim().toLowerCase().replace(/^["'\s]+|["'\s]+$/g, ''))
    .filter(t => t.length > 1 && t.length <= 40)
    .slice(0, 4);
}

export async function runTaggingPass(
  articles: Article[],
  existingArticleTags: ArticleTag[],
  onTagged: (tag: ArticleTag) => void,
): Promise<void> {
  if (!isPromptApiAvailable()) return;

  const taggedIds = new Set(existingArticleTags.map(t => t.articleId));
  const toTag = articles.filter(a => !taggedIds.has(a.id));
  if (toTag.length === 0) return;

  const session: LMSession = await (globalThis as any).LanguageModel.create({
    systemPrompt: 'You are a news article tagger. Return only a comma-separated list of lowercase topic tags.',
  });

  const corpus = new Set(existingArticleTags.flatMap(t => t.tags));

  for (const article of toTag) {
    const tags = await tagArticle(article, [...corpus], session);
    tags.forEach(t => corpus.add(t));
    onTagged({ articleId: article.id, tags, taggedAt: Date.now() });
  }
}

export async function runClassificationPass(
  articles: Article[],
  label: UserLabel,
  existingHits: LabelHit[],
): Promise<LabelHit[]> {
  if (!isPromptApiAvailable()) return [];

  const hitSet = new Set(
    existingHits.filter(h => h.labelId === label.id).map(h => h.articleId),
  );

  const toClassify = articles.filter(a => !hitSet.has(a.id));
  if (toClassify.length === 0) return [];

  const session: LMSession = await (globalThis as any).LanguageModel.create({
    systemPrompt: 'You are a news article classifier. Answer only YES or NO.',
  });

  const newHits: LabelHit[] = [];
  for (const article of toClassify) {
    const matches = await classifyArticle(article, label, session);
    if (matches) {
      newHits.push({ articleId: article.id, labelId: label.id, classifiedAt: Date.now() });
    }
  }
  return newHits;
}
