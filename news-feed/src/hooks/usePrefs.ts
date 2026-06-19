import { useCallback, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { kvGet, kvSet } from '../services/kvStore';
import {
  DEFAULT_PREFS,
  applyDecay,
  toggleTopic,
  addUserLabel,
  renameUserLabel,
} from '../services/storage';
import { DEFAULT_SOURCES } from '../services/newsService';
import type { Topic, UserLabel, UserPrefs } from '../types';

export const PREFS_ID = 'user-prefs';

export interface UsePrefsResult {
  prefs: UserPrefs;
  prefsReady: boolean;
  prefsRef: MutableRefObject<UserPrefs>;
  setPrefsState: Dispatch<SetStateAction<UserPrefs>>;
  setPrefsReady: Dispatch<SetStateAction<boolean>>;
  updatePrefs: (next: UserPrefs) => void;
  loadPrefs: () => Promise<UserPrefs>;
  onToggleTopic: (topic: Topic) => void;
  onToggleAiBar: () => void;
  onToggleTheme: () => void;
  onAddLabel: (label: UserLabel) => void;
  onRenameLabel: (labelId: string, name: string) => void;
}

export function usePrefs(): UsePrefsResult {
  const [prefs, setPrefsState] = useState<UserPrefs>(DEFAULT_PREFS);
  const [prefsReady, setPrefsReady] = useState(false);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const updatePrefs = useCallback((next: UserPrefs) => {
    setPrefsState(next);
    kvSet(PREFS_ID, next).catch(console.error);
  }, []);

  // Loads prefs from storage, applies migrations and weight decay, sets state.
  // Returns the resolved prefs so the caller's Promise.all can coordinate
  // with other kv loads (cache, importedSaves, etc.).
  const loadPrefs = useCallback(async (): Promise<UserPrefs> => {
    try {
      const doc = await kvGet<UserPrefs>(PREFS_ID);
      let merged: UserPrefs = { ...DEFAULT_PREFS, ...doc };
      let shouldPersist = false;
      // One-time migration: old whitelist `enabledSources` → blacklist `disabledSourceIds`
      if ((merged.enabledSources?.length ?? 0) > 0 && (merged.disabledSourceIds?.length ?? 0) === 0) {
        const enabledSet = new Set(merged.enabledSources);
        merged = {
          ...merged,
          disabledSourceIds: DEFAULT_SOURCES.map(s => s.id).filter(id => !enabledSet.has(id)),
          enabledSources: [],
        };
        shouldPersist = true;
      }
      // One-time migration: ensure all saved ids have a timestamp for cross-device ordering.
      if (merged.savedIds.length > 0) {
        const nextSavedAtById = { ...(merged.savedAtById ?? {}) };
        let addedAny = false;
        const base = Date.now() - merged.savedIds.length * 60_000;
        merged.savedIds.forEach((id, idx) => {
          if (nextSavedAtById[id] === undefined) {
            nextSavedAtById[id] = base + idx;
            addedAny = true;
          }
        });
        if (addedAny) {
          merged = { ...merged, savedAtById: nextSavedAtById };
          shouldPersist = true;
        }
      }
      const decayed = applyDecay(merged);
      if (decayed !== merged) shouldPersist = true;
      setPrefsState(decayed);
      if (shouldPersist) kvSet(PREFS_ID, decayed).catch(console.error);
      return decayed;
    } catch {
      return DEFAULT_PREFS;
    }
  }, []);

  const onToggleTopic = useCallback((topic: Topic) => {
    updatePrefs(toggleTopic(topic, prefsRef.current));
  }, [updatePrefs]);

  const onToggleAiBar = useCallback(() => {
    updatePrefs({ ...prefsRef.current, hideAiBar: !prefsRef.current.hideAiBar });
  }, [updatePrefs]);

  const onToggleTheme = useCallback(() => {
    const next = prefsRef.current.theme === 'light' ? 'dark' : 'light';
    updatePrefs({ ...prefsRef.current, theme: next });
  }, [updatePrefs]);

  const onAddLabel = useCallback((label: UserLabel) => {
    updatePrefs(addUserLabel(label, prefsRef.current));
  }, [updatePrefs]);

  const onRenameLabel = useCallback((labelId: string, name: string) => {
    updatePrefs(renameUserLabel(labelId, name, prefsRef.current));
  }, [updatePrefs]);

  return {
    prefs,
    prefsReady,
    prefsRef,
    setPrefsState,
    setPrefsReady,
    updatePrefs,
    loadPrefs,
    onToggleTopic,
    onToggleAiBar,
    onToggleTheme,
    onAddLabel,
    onRenameLabel,
  };
}
