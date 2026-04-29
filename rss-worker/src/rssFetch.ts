import { parseFeed, type ArticleWire } from './parseFeed';
import type { NewsSource } from './sources';

const UA = 'BoomerangNews/1.0 (+https://github.com/victusfate/boomerang)';
const FETCH_TIMEOUT_MS = 25_000;
const CONCURRENCY = 4;
const BATCH_PAUSE_MS = 120;
/** Max bytes to read per RSS feed — guards against oversized responses. */
const MAX_FEED_BYTES = 5 * 1024 * 1024; // 5 MB

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchXmlWithRetry(feedUrl: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await sleep(400 * 2 ** (attempt - 1));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(feedUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': UA,
          Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        },
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const cl = parseInt(res.headers.get('Content-Length') ?? '0', 10);
      if (cl > MAX_FEED_BYTES) throw new Error(`Feed too large (Content-Length ${cl})`);
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_FEED_BYTES) throw new Error(`Feed too large (${buf.byteLength} bytes)`);
      const text = new TextDecoder().decode(buf);
      if (text.length < 100) throw new Error('empty body');
      return text;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export interface BundleResult {
  articles: ArticleWire[];
  errors: { sourceId: string; message: string }[];
}

/**
 * Fetch feeds in batches of `concurrency`, pause between batches to avoid hammering origins.
 */
export async function fetchFeedsStaggered(sources: NewsSource[]): Promise<BundleResult> {
  const errors: { sourceId: string; message: string }[] = [];
  const articles: ArticleWire[] = [];

  for (let i = 0; i < sources.length; i += CONCURRENCY) {
    const batch = sources.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async source => {
        const xml = await fetchXmlWithRetry(source.feedUrl);
        return await parseFeed(xml, source);
      }),
    );

    settled.forEach((result, j) => {
      const source = batch[j];
      if (result.status === 'fulfilled') {
        articles.push(...result.value);
      } else {
        const reason = result.reason;
        const message = reason instanceof Error ? reason.message : String(reason);
        errors.push({ sourceId: source.id, message });
      }
    });

    if (i + CONCURRENCY < sources.length && BATCH_PAUSE_MS > 0) {
      await sleep(BATCH_PAUSE_MS);
    }
  }

  return { articles, errors };
}
