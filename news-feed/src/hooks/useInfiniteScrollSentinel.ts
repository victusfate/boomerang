import { useEffect, useRef } from 'react';
import type { FeedView } from '../types';

const SCROLL_THRESHOLD_PX = 600;
const SENTINEL_ROOT_MARGIN = `${SCROLL_THRESHOLD_PX}px`; // start loading well before the bottom edge

export function useInfiniteScrollSentinel(
  onLoadMore: () => void,
  view: FeedView,
  totalLoaded: number,
  hasMore: boolean,
): { sentinelRef: React.RefObject<HTMLDivElement | null> } {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;

  // IntersectionObserver watches the sentinel to fire load-more at the bottom.
  // Recreated only when the view changes (not on every article load).
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || view !== 'feed') return;
    const observer = new IntersectionObserver(
      entries => { if (entries[0].isIntersecting) onLoadMoreRef.current(); },
      { rootMargin: SENTINEL_ROOT_MARGIN },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [view]);

  // When new articles arrive the sentinel may already be inside the observer's
  // rootMargin zone so no new IO event fires. Manually trigger when pool grows.
  const prevTotalRef = useRef(0);
  useEffect(() => {
    if (totalLoaded <= prevTotalRef.current) return;
    prevTotalRef.current = totalLoaded;
    if (!hasMore || view !== 'feed') return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const rect = sentinel.getBoundingClientRect();
    if (rect.top <= window.innerHeight + SCROLL_THRESHOLD_PX) onLoadMore();
  }, [totalLoaded, hasMore, view, onLoadMore]);

  return { sentinelRef };
}
