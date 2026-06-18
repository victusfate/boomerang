import { useEffect } from 'react';

const DWELL_MS = 3_000;

export function useArticleDwell(
  articleId: string,
  cardRef: React.RefObject<HTMLElement | null>,
  onSeen: ((id: string) => void) | undefined,
): void {
  useEffect(() => {
    if (!onSeen) return;
    const el = cardRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        if (!timer) timer = setTimeout(() => { onSeen(articleId); timer = null; }, DWELL_MS);
      } else {
        if (timer) { clearTimeout(timer); timer = null; }
      }
    }, { threshold: 0.5 });
    observer.observe(el);
    return () => { observer.disconnect(); if (timer) clearTimeout(timer); };
  }, [articleId, onSeen]); // cardRef is stable — excluded intentionally
}
