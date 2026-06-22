import { useEffect, useState } from 'react';
import type { UserPrefs } from '../types';
import { isBackfilled, markBackfilled, writeHistoryEntries } from '../services/articleHistory';
import { parseRecArticlesResponse } from '../services/recArticlesLookup';

const MAX_BACKFILL_IDS = 500;

export function useHistoryBackfill(
  prefs: UserPrefs,
  platformWorkerUrl: string,
  /** Prefs hydration flag from useFeed — backfill must not run against DEFAULT_PREFS. */
  ready: boolean,
): { backfilled: boolean } {
  const [backfilled, setBackfilled] = useState(true); // optimistic: suppress Tier 2 until we know

  useEffect(() => {
    if (!ready) return; // wait for prefs to hydrate; IndexedDB flag keeps this idempotent
    if (!platformWorkerUrl) {
      setBackfilled(true);
      return;
    }

    let cancelled = false;

    async function run() {
      const already = await isBackfilled();
      if (already || cancelled) {
        setBackfilled(true);
        return;
      }

      setBackfilled(false);

      // Collect all ids: unsavedAtById keys (dequeue events) take priority, then readIds
      const unsavedIds = Object.keys(prefs.unsavedAtById ?? {});
      const readIds = prefs.readIds ?? [];
      const seen = new Set<string>();
      const ids: string[] = [];
      for (const id of [...unsavedIds, ...readIds]) {
        if (!seen.has(id)) {
          seen.add(id);
          ids.push(id);
          if (ids.length >= MAX_BACKFILL_IDS) break;
        }
      }

      if (ids.length === 0) {
        await markBackfilled();
        if (!cancelled) setBackfilled(true);
        return;
      }

      try {
        const res = await fetch(`${platformWorkerUrl}/rec/articles`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        });
        if (!res.ok || cancelled) return;
        const data = parseRecArticlesResponse(await res.json());
        if (cancelled) return;

        const unsavedAt = prefs.unsavedAtById ?? {};
        const entries = data.articles.map(a => ({
          id: a.id,
          title: a.title,
          url: a.url,
          source: a.source,
          sourceId: a.sourceId,
          publishedAt: a.publishedAt,
          interactedAt: unsavedAt[a.id] ?? Date.now(),
        }));

        await writeHistoryEntries(entries);
        await markBackfilled();
        if (!cancelled) setBackfilled(true);
      } catch {
        // Network failure: leave backfilled=false so Tier 2 stays active
      }
    }

    void run();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]); // runs when prefs become ready; prefs snapshot at that point is intentional

  return { backfilled };
}
