import type { Article, ArticleTag, LabelHit, UserLabel } from '../types';

export interface LMSession {
  prompt(text: string): Promise<string>;
}

const TAG_LOG = '[AI Tags]';

/** Must match session `create()` so Chrome can attest I/O safety; keep in sync with `availability()`. */
const LM_TEXT_EN_IO = {
  expectedInputs: [{ type: 'text' as const, languages: ['en' as const] }],
  expectedOutputs: [{ type: 'text' as const, languages: ['en' as const] }],
};

function lmCreateOptions(systemPrompt: string, monitor?: (m: EventTarget) => void) {
  return monitor
    ? { systemPrompt, ...LM_TEXT_EN_IO, monitor }
    : { systemPrompt, ...LM_TEXT_EN_IO };
}

async function readAvailability(label: string, options?: unknown): Promise<string | null> {
  const LM = (globalThis as any).LanguageModel;
  if (typeof LM?.availability !== 'function') return null;
  try {
    const status = options === undefined
      ? await LM.availability()
      : await LM.availability(options);
    console.info(TAG_LOG, `availability ${label}`, status, options ?? {});
    return String(status);
  } catch (e) {
    console.warn(TAG_LOG, `availability ${label} error`, e, options ?? {});
    return null;
  }
}

function isProbablyMobileBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

async function logPromptApiDiagnostics(tag: string): Promise<string | null> {
  const userActivation = typeof navigator !== 'undefined'
    ? (navigator as any).userActivation
    : null;
  const mobileLike = isProbablyMobileBrowser();
  console.info(TAG_LOG, tag, 'Prompt API diagnostics', {
    hasLanguageModel: isPromptApiAvailable(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
    languages: typeof navigator !== 'undefined' ? navigator.languages : null,
    secureContext: typeof isSecureContext !== 'undefined' ? isSecureContext : null,
    origin: typeof location !== 'undefined' ? location.origin : null,
    mobileLike,
    userActivation: userActivation
      ? { isActive: userActivation.isActive, hasBeenActive: userActivation.hasBeenActive }
      : null,
    docs: 'https://developer.chrome.com/docs/ai/get-started',
    internals: 'chrome://on-device-internals',
  });
  if (mobileLike) {
    console.info(
      TAG_LOG,
      'Prompt API likely unavailable because Chrome reports a mobile user agent. Disable DevTools device emulation / mobile UA override and retry on desktop Chrome.',
    );
  }
  return readAvailability('text en I/O', LM_TEXT_EN_IO);
}

async function getLanguageModelAvailability(tag: string): Promise<string | null> {
  return logPromptApiDiagnostics(tag);
}

function canCreateLanguageModel(availability: string | null): boolean {
  // Older implementations may not expose availability(); let create() be the compatibility check.
  return availability === null || availability === 'available';
}

function isModelLoadingStatus(availability: string | null): boolean {
  return availability === 'downloadable' || availability === 'downloading';
}

function hasActiveUserGesture(): boolean {
  if (typeof navigator === 'undefined') return false;
  return Boolean((navigator as any).userActivation?.isActive);
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function isPromptApiAvailable(): boolean {
  return typeof (globalThis as any).LanguageModel !== 'undefined';
}

export async function getPromptApiAvailability(): Promise<string | null> {
  if (!isPromptApiAvailable()) return null;
  return readAvailability('status poll text en I/O', LM_TEXT_EN_IO);
}

export async function classifyArticle(
  article: Article,
  label: UserLabel,
  session: LMSession,
): Promise<boolean> {
  const text = `${article.title}. ${article.description}`.slice(0, 400);
  const input = `Does this article relate to "${label.name}"? Answer YES or NO only.\n\n${text}`;
  const response = await session.prompt(input);
  console.info(TAG_LOG, 'classifyArticle prompt I/O', { articleId: article.id, input, output: response });
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
  const input = `${context}Tag this article with 2-4 concise topic tags. Prefer existing tags when appropriate. Return only a comma-separated list, no explanation.\n\n${text}`;
  const response = await session.prompt(input);
  console.info(TAG_LOG, 'tagArticle prompt I/O', { articleId: article.id, input, output: response });
  return response
    .split(',')
    .map(t => t.trim().toLowerCase().replace(/^["'\s]+|["'\s]+$/g, ''))
    .filter(t => t.length > 1 && t.length <= 40)
    .slice(0, 4);
}

export type TaggingPassHooks = {
  /** Fires around Chrome's model availability check before any session is created. */
  onModelStatus?: (status: 'checking' | 'available' | 'downloadable' | 'downloading' | 'starting-download') => void;
  /** Fires with Chrome's model download progress if create() starts a download. */
  onModelDownloadProgress?: (loaded: number) => void;
  /** Fires after `LanguageModel.create()` — first chance to show progress before any prompt. */
  onSessionReady?: () => void;
  /** Fires before each `tagArticle` call (slow on first article while the model warms up). */
  onArticleStart?: (index: number, total: number, articleId?: string) => void;
  /** Fires when Chrome exposes LanguageModel but the local model is not ready/allowed. */
  onUnavailable?: (availability: string | null, reason: 'mobile-user-agent' | null) => void;
};

export async function runTaggingPass(
  articles: Article[],
  existingArticleTags: ArticleTag[],
  onTagged: (tag: ArticleTag) => void,
  hooks?: TaggingPassHooks,
): Promise<void> {
  if (!isPromptApiAvailable()) {
    console.info(TAG_LOG, 'skip — LanguageModel not available');
    return;
  }

  const taggedIds = new Set(existingArticleTags.map(t => t.articleId));
  const toTag = articles.filter(a => !taggedIds.has(a.id));
  if (toTag.length === 0) {
    console.info(TAG_LOG, 'skip — all articles already tagged', {
      pool: articles.length,
      knownTagged: existingArticleTags.length,
    });
    return;
  }

  const passT0 = nowMs();
  console.info(TAG_LOG, 'LanguageModel availability check starting…', { toTag: toTag.length, pool: articles.length });
  hooks?.onModelStatus?.('checking');
  const availability = await getLanguageModelAvailability('before tagging session');
  if (availability === 'downloadable' || availability === 'downloading') {
    hooks?.onModelStatus?.(availability);
  }
  const canStartDownload = availability === 'downloadable' && hasActiveUserGesture();
  if (canStartDownload) {
    hooks?.onModelStatus?.('starting-download');
  }
  if (isModelLoadingStatus(availability) && !canStartDownload) {
    console.info(TAG_LOG, 'skip — LanguageModel model is not loaded yet', {
      availability,
      userActivation: typeof navigator !== 'undefined' ? (navigator as any).userActivation : null,
      help: 'https://developer.chrome.com/docs/ai/get-started',
    });
    return;
  }
  if (!canCreateLanguageModel(availability) && !canStartDownload) {
    console.info(TAG_LOG, 'skip — LanguageModel unavailable for tagging', {
      availability,
      reason: isProbablyMobileBrowser() ? 'mobile-user-agent' : null,
      help: 'https://developer.chrome.com/docs/ai/get-started',
    });
    hooks?.onUnavailable?.(
      availability,
      isProbablyMobileBrowser() ? 'mobile-user-agent' : null,
    );
    return;
  }
  const createT0 = nowMs();
  if (availability === 'available' || availability === null) {
    hooks?.onModelStatus?.('available');
  }
  console.info(TAG_LOG, 'LanguageModel.create starting…', { toTag: toTag.length, pool: articles.length });
  const session: LMSession = await (globalThis as any).LanguageModel.create(
    lmCreateOptions(
      'You are a news article tagger. Return only a comma-separated list of lowercase topic tags.',
      (monitor) => {
        monitor.addEventListener('downloadprogress', (e) => {
          const loaded = typeof (e as any).loaded === 'number' ? (e as any).loaded : 0;
          console.info(TAG_LOG, 'LanguageModel download progress', { loaded });
          hooks?.onModelDownloadProgress?.(loaded);
        });
      },
    ),
  );
  console.info(TAG_LOG, 'LanguageModel.create done', {
    ms: Math.round(nowMs() - createT0),
  });

  hooks?.onSessionReady?.();

  const corpus = new Set(existingArticleTags.flatMap(t => t.tags));

  for (let i = 0; i < toTag.length; i++) {
    const article = toTag[i];
    const idx = i + 1;
    hooks?.onArticleStart?.(idx, toTag.length, article.id);
    const titleSnippet = article.title.slice(0, 72) + (article.title.length > 72 ? '…' : '');
    console.info(TAG_LOG, 'prompt start', { idx, total: toTag.length, id: article.id, title: titleSnippet });
    const promptT0 = nowMs();
    const tags = await tagArticle(article, [...corpus], session);
    const promptMs = Math.round(nowMs() - promptT0);
    tags.forEach(t => corpus.add(t));
    console.info(TAG_LOG, 'prompt done', {
      idx,
      total: toTag.length,
      id: article.id,
      ms: promptMs,
      tags,
    });
    onTagged({ articleId: article.id, tags, taggedAt: Date.now() });
    // Yield a frame so React can paint progress (1/N, 2/N, …) between slow LLM calls.
    if (typeof requestAnimationFrame !== 'undefined') {
      await new Promise<void>(r => requestAnimationFrame(() => r()));
    }
  }
  console.info(TAG_LOG, 'pass complete', {
    tagged: toTag.length,
    totalMs: Math.round(nowMs() - passT0),
  });
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

  const availability = await getLanguageModelAvailability('before classify session');
  if (!canCreateLanguageModel(availability)) return [];
  const session: LMSession = await (globalThis as any).LanguageModel.create(
    lmCreateOptions('You are a news article classifier. Answer only YES or NO.'),
  );

  const newHits: LabelHit[] = [];
  for (const article of toClassify) {
    const matches = await classifyArticle(article, label, session);
    if (matches) {
      newHits.push({ articleId: article.id, labelId: label.id, classifiedAt: Date.now() });
    }
  }
  return newHits;
}
