import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { kvSet } from '../services/kvStore';
import { getPromptApiAvailability, isPromptApiAvailable, runTaggingPass } from '../services/labelClassifier';
import type { Article, ArticleTag } from '../types';
import type { UseFeedMetaCallbacks } from './useFeed';

export const ARTICLE_TAGS_ID = 'ai-article-tags';

const AI_MODEL_POLL_INTERVAL_MS = 5_000;
const IDLE_CALLBACK_TIMEOUT_MS  = 5_000;
const AI_TAGS_LOG_PREFIX        = '[AI Tags]';

interface UseAiTaggingParams {
  allArticlesRef: MutableRefObject<Article[]>;
  articleTagsRef: MutableRefObject<ArticleTag[]>;
  setArticleTags: React.Dispatch<React.SetStateAction<ArticleTag[]>>;
  metaCallbacks?: UseFeedMetaCallbacks;
}

export function useAiTagging({
  allArticlesRef,
  articleTagsRef,
  setArticleTags,
  metaCallbacks,
}: UseAiTaggingParams): {
  classificationStatus: string;
  aiTaggingStarted: boolean;
  aiAllTagged: boolean;
  taggingArticleId: string | null;
  scheduleTaggingPass: (articles: Article[]) => void;
  handleStartAiTagging: () => void;
} {
  const [classificationStatus, setClassificationStatus] = useState('');
  const [aiTaggingStarted, setAiTaggingStarted] = useState(false);
  const [aiAllTagged, setAiAllTagged] = useState(false);
  const [taggingArticleId, setTaggingArticleId] = useState<string | null>(null);
  const aiModelPollTimerRef = useRef<number | null>(null);

  const stopAiModelPolling = useCallback(() => {
    if (aiModelPollTimerRef.current) {
      window.clearInterval(aiModelPollTimerRef.current);
      aiModelPollTimerRef.current = null;
    }
  }, []);

  const startAiModelPolling = useCallback(() => {
    if (aiModelPollTimerRef.current) return;
    const poll = async () => {
      const availability = await getPromptApiAvailability();
      if (availability === 'available') {
        stopAiModelPolling();
        setClassificationStatus('Chrome AI model ready — starting tagging…');
        if (allArticlesRef.current.length > 0) {
          schedulePassRef.current([...allArticlesRef.current]);
        }
      } else if (availability === 'downloading') {
        setClassificationStatus('Chrome AI model downloading…');
      } else if (availability === 'downloadable') {
        setClassificationStatus('Chrome AI model needs download — use Chrome AI setup');
      } else if (availability === 'unavailable') {
        stopAiModelPolling();
        setClassificationStatus('Chrome AI unavailable (unavailable) — check browser/model support');
      }
    };
    void poll();
    aiModelPollTimerRef.current = window.setInterval(() => { void poll(); }, AI_MODEL_POLL_INTERVAL_MS);
  }, [stopAiModelPolling, allArticlesRef]);

  // Cache-load, post-fetch, the model-ready poll, and the manual button can
  // all schedule passes; one at a time — each pass owns its own LM session.
  const passInFlightRef = useRef(false);

  const scheduleTaggingPass = useCallback((articles: Article[]) => {
    if (!isPromptApiAvailable()) {
      console.info(`${AI_TAGS_LOG_PREFIX} schedule skipped — LanguageModel not available`);
      return;
    }
    if (passInFlightRef.current) {
      console.info(`${AI_TAGS_LOG_PREFIX} schedule skipped — a pass is already running`);
      return;
    }
    const schedule: (cb: () => void) => void =
      typeof requestIdleCallback !== 'undefined'
        ? (cb) => requestIdleCallback(() => cb(), { timeout: IDLE_CALLBACK_TIMEOUT_MS })
        : (cb) => setTimeout(cb, 0);

    passInFlightRef.current = true;
    schedule(() => {
      void (async () => {
        const idleT0 = typeof performance !== 'undefined' ? performance.now() : Date.now();

        const rankMap = new Map(allArticlesRef.current.map((a, i) => [a.id, i]));
        const sortedArticles = [...articles].sort((a, b) => {
          const ra = rankMap.get(a.id) ?? Infinity;
          const rb = rankMap.get(b.id) ?? Infinity;
          return ra - rb;
        });

        console.info(AI_TAGS_LOG_PREFIX + ' idle run start', { inputArticles: sortedArticles.length });

        const existing = articleTagsRef.current;
        const toTag = sortedArticles.filter(a => !existing.some(t => t.articleId === a.id));
        if (toTag.length === 0) {
          console.info(AI_TAGS_LOG_PREFIX + ' skip — nothing new to tag', {
            inputArticles: sortedArticles.length,
            storedTagRows: existing.length,
          });
          setTaggingArticleId(null);
          setClassificationStatus('');
          setAiAllTagged(true);
          return;
        }
        setAiAllTagged(false);
        setClassificationStatus(`Preparing on-device model… (${toTag.length} articles)`);
        let done = 0;
        try {
          await runTaggingPass(sortedArticles, existing, (tag) => {
            done++;
            setClassificationStatus(`Tagging articles… ${done}/${toTag.length}`);
            metaCallbacks?.feedTaggedArticle(tag.articleId, tag.tags);
            const prev = articleTagsRef.current;
            if (prev.some(t => t.articleId === tag.articleId)) return; // dedupe per article
            const updated = [...prev, tag];
            articleTagsRef.current = updated;
            setArticleTags(updated);
            kvSet(ARTICLE_TAGS_ID, { hits: updated }).catch(console.error);
          }, {
            onModelStatus: (status) => {
              const copy = {
                checking: 'Checking Chrome AI model…',
                available: 'Starting Chrome AI model…',
                'starting-download': 'Starting Chrome AI model download…',
                downloadable: 'Chrome AI model needs download — use Chrome AI setup',
                downloading: 'Chrome AI model downloading…',
              } satisfies Record<typeof status, string>;
              setClassificationStatus(copy[status]);
              if (status === 'downloadable' || status === 'downloading' || status === 'starting-download') {
                startAiModelPolling();
              }
            },
            onModelDownloadProgress: (loaded) => {
              setClassificationStatus(`Chrome AI model downloading… ${Math.round(loaded * 100)}%`);
            },
            onSessionReady: () => {
              setAiTaggingStarted(true);
              setClassificationStatus(`Tagging articles… 0/${toTag.length}`);
            },
            onArticleStart: (i, total, articleId) => {
              setClassificationStatus(`Tagging article ${i}/${total}…`);
              setTaggingArticleId(articleId ?? null);
            },
            onUnavailable: (availability, reason) => {
              setClassificationStatus(
                reason === 'mobile-user-agent'
                  ? 'Chrome AI unavailable — disable mobile emulation'
                  : `Chrome AI unavailable (${availability ?? 'unknown'}) — check browser/model support`,
              );
            },
          });
        } catch (e) {
          console.error(AI_TAGS_LOG_PREFIX + ' pass threw', e);
          const msg = e instanceof Error ? e.message : String(e);
          if (
            msg.includes('service is not running')
            || (typeof DOMException !== 'undefined' && e instanceof DOMException && e.name === 'NotAllowedError')
          ) {
            console.info(
              AI_TAGS_LOG_PREFIX + ' On-device AI may be stopped or still downloading. Check chrome://on-device-internals, flags in https://developer.chrome.com/docs/ai/get-started — first create() may need a recent user gesture.',
            );
          }
          setTaggingArticleId(null);
          setClassificationStatus('');
          return;
        }
        setTaggingArticleId(null);
        metaCallbacks?.endTaggingPass();
        const idleMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - idleT0);
        console.info(AI_TAGS_LOG_PREFIX + ' idle run finished', {
          tagged: done,
          expected: toTag.length,
          wallMsFromIdleStart: idleMs,
        });
        if (done > 0) {
          setClassificationStatus(`Tagged — ${done} articles processed`);
        }
      })().finally(() => { passInFlightRef.current = false; });
    });
  }, [startAiModelPolling, allArticlesRef, articleTagsRef, setArticleTags, metaCallbacks]);

  const schedulePassRef = useRef(scheduleTaggingPass);
  schedulePassRef.current = scheduleTaggingPass;

  const handleStartAiTagging = useCallback(() => {
    if (allArticlesRef.current.length === 0) {
      setClassificationStatus('Load articles before starting Chrome AI tagging');
      return;
    }
    schedulePassRef.current([...allArticlesRef.current]);
  }, [allArticlesRef]);

  useEffect(() => () => stopAiModelPolling(), []);

  return {
    classificationStatus,
    aiTaggingStarted,
    aiAllTagged,
    taggingArticleId,
    scheduleTaggingPass,
    handleStartAiTagging,
  };
}
