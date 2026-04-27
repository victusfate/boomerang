import type { Article, LabelHit, UserLabel } from '../types';

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
