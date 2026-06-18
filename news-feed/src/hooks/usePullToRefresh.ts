import { useCallback, useEffect, useRef } from 'react';

const PULL_THRESHOLD = 80; // px of downward drag to trigger refresh

export function usePullToRefresh(
  onRefresh: () => void,
  locked: boolean,
): { pullIndicatorRef: React.RefObject<HTMLDivElement | null> } {
  const pullIndicatorRef = useRef<HTMLDivElement>(null);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  // Gesture state in a ref to avoid re-renders during drag
  const pullGestureRef = useRef({ active: false, startY: 0, progress: 0 });

  // Pull-to-refresh visuals are driven by direct DOM writes — setState per
  // touchmove frame re-renders the whole app (every card) during the drag.
  const setPullVisual = useCallback((progress: number) => {
    const el = pullIndicatorRef.current;
    if (!el) return;
    el.style.display = progress > 0 ? 'flex' : 'none';
    const inner = el.firstElementChild as HTMLElement | null;
    if (!inner) return;
    inner.style.opacity = String(progress);
    inner.style.transform = `scale(${0.5 + progress * 0.5})`;
    inner.classList.toggle('spin-ready', progress >= 1);
  }, []);

  useEffect(() => {
    if (locked) return; // don't capture gestures when a modal layer is open
    let triggered = false;

    const onTouchStart = (e: TouchEvent) => {
      if (window.scrollY > 5) return; // only activate at top of page
      pullGestureRef.current = { active: true, startY: e.touches[0].clientY, progress: 0 };
      triggered = false;
    };

    const onTouchMove = (e: TouchEvent) => {
      const g = pullGestureRef.current;
      if (!g.active) return;
      const delta = e.touches[0].clientY - g.startY;
      if (delta <= 0) { g.active = false; setPullVisual(0); return; }
      const progress = Math.min(delta / PULL_THRESHOLD, 1);
      g.progress = progress;
      setPullVisual(progress);
      if (window.scrollY <= 5) e.preventDefault();
    };

    const onTouchEnd = () => {
      const g = pullGestureRef.current;
      if (!g.active) return;
      const willRefresh = g.progress >= 1 && !triggered;
      g.active = false;
      g.progress = 0;
      setPullVisual(0);
      if (willRefresh) { triggered = true; onRefreshRef.current(); }
    };

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, [locked, setPullVisual]);

  return { pullIndicatorRef };
}
