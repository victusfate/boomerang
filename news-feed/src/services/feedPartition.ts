import type { CustomSource, NewsSource } from '../types';

/** Splits built-ins by `priority` (1 = fast, 2 = background); all custom go to background. */
export function partitionSourcesForSplitFetch(
  sources: NewsSource[],
  customSources: CustomSource[],
): {
  fast: { sources: NewsSource[]; custom: CustomSource[] };
  background: { sources: NewsSource[]; custom: CustomSource[] };
} {
  const fast: NewsSource[] = [];
  const background: NewsSource[] = [];
  for (const s of sources) {
    if ((s.priority ?? 2) === 1) fast.push(s);
    else background.push(s);
  }
  return {
    fast: { sources: fast, custom: [] },
    background: { sources: background, custom: customSources },
  };
}
