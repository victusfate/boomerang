import { useState, useEffect, useRef, useCallback } from 'react';
import {
  DEFAULT_META_WORKER_URL, metaWorkerWsUrl, parseServerMsg,
  type ClientMsg,
} from '../services/metaWorker.ts';

const envMeta = import.meta.env.VITE_META_WORKER_URL?.replace(/\/$/, '') ?? '';
const WORKER_BASE = envMeta || (import.meta.env.PROD ? DEFAULT_META_WORKER_URL : '');

const RECONNECT_DELAY_MS = 3_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export type MetaTagsMap = Map<string, string[]>;

export interface UseMetaWorkerResult {
  metaTagsMap: MetaTagsMap;
  feedTaggedArticle: (articleId: string, tags: string[]) => void;
  endTaggingPass: () => void;
}

export function useMetaWorker(articleIds: string[]): UseMetaWorkerResult {
  const [metaTagsMap, setMetaTagsMap] = useState<MetaTagsMap>(new Map());
  const wsRef = useRef<WebSocket | null>(null);
  const lastTagsAtRef = useRef<number>(0);
  const catchUpSinceRef = useRef<number>(0); // stable across paginated catchUp requests
  const reconnectDelayRef = useRef<number>(RECONNECT_DELAY_MS);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const articleIdsRef = useRef<string[]>(articleIds);
  const pendingBufferRef = useRef<Array<{ articleId: string; tags: string[] }>>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const FLUSH_INTERVAL_MS = 20_000;
  const MAX_BATCH = 200;

  // Keep articleIds ref current so the reconnect closure sees fresh value
  useEffect(() => { articleIdsRef.current = articleIds; }, [articleIds]);

  const send = useCallback((msg: ClientMsg) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const flush = useCallback(() => {
    if (pendingBufferRef.current.length === 0) return;
    const batch = pendingBufferRef.current.splice(0, MAX_BATCH);
    send({ type: 'submitTags', articles: batch });
    if (pendingBufferRef.current.length > 0) {
      // More pending — schedule next flush immediately
      flushTimerRef.current = setTimeout(flush, 0);
    }
  }, [send]);

  const stopFlushTimer = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, []);

  const feedTaggedArticle = useCallback((articleId: string, tags: string[]) => {
    pendingBufferRef.current.push({ articleId, tags });
    if (pendingBufferRef.current.length >= MAX_BATCH) {
      stopFlushTimer();
      flush();
      // Restart the 20s timer for any remainder
      flushTimerRef.current = setTimeout(flush, FLUSH_INTERVAL_MS);
    } else if (!flushTimerRef.current) {
      flushTimerRef.current = setTimeout(flush, FLUSH_INTERVAL_MS);
    }
  }, [flush, stopFlushTimer]);

  const endTaggingPass = useCallback(() => {
    stopFlushTimer();
    flush();
  }, [flush, stopFlushTimer]);

  const connect = useCallback(() => {
    if (!WORKER_BASE) return;

    const ws = new WebSocket(metaWorkerWsUrl(WORKER_BASE));
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectDelayRef.current = RECONNECT_DELAY_MS;
      const ids = articleIdsRef.current;
      const since = lastTagsAtRef.current;
      ws.send(JSON.stringify({ type: 'subscribe', articleIds: ids }));
      if (since > 0) {
        catchUpSinceRef.current = since;
        ws.send(JSON.stringify({ type: 'catchUp', since }));
      }
    };

    ws.onmessage = (e) => {
      const msg = parseServerMsg(e.data as string);
      if (!msg) return;

      if (msg.type === 'ping') {
        send({ type: 'pong' });
        return;
      }

      if (msg.type === 'tags') {
        lastTagsAtRef.current = Math.max(lastTagsAtRef.current, msg.updatedAt);
        setMetaTagsMap(prev => {
          const next = new Map(prev);
          next.set(msg.articleId, msg.tags);
          return next;
        });
        return;
      }

      if (msg.type === 'catchUp') {
        setMetaTagsMap(prev => {
          const next = new Map(prev);
          for (const u of msg.updates) {
            next.set(u.articleId, u.tags);
            lastTagsAtRef.current = Math.max(lastTagsAtRef.current, u.updatedAt);
          }
          return next;
        });
        // Fetch next page if more results available
        if (msg.hasMore && msg.cursor !== undefined) {
          send({ type: 'catchUp', since: catchUpSinceRef.current, before: msg.cursor });
        }
        return;
      }
    };

    ws.onclose = () => {
      wsRef.current = null;
      const delay = reconnectDelayRef.current;
      reconnectDelayRef.current = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
      reconnectTimerRef.current = setTimeout(connect, delay);
    };

    ws.onerror = () => ws.close();
  }, [send]);

  // Connect on mount; reconnect when tab becomes visible
  useEffect(() => {
    connect();

    const onVisible = () => {
      if (document.visibilityState === 'visible' && !wsRef.current) connect();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { metaTagsMap, feedTaggedArticle, endTaggingPass };
}
