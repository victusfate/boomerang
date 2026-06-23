import { useEffect, useRef } from 'react';
import type { Article, CustomSource, Topic, UserLabel, UserPrefs } from '../types';
import type { MetaStatus } from '../hooks/useMetaWorker';
import type { SyncErrorDetails } from '../hooks/useSyncWorker';
import { TopicsSection }      from './settings/TopicsSection';
import { SourcesSection }     from './settings/SourcesSection';
import { LabelsSection }      from './settings/LabelsSection';
import { SyncSection }        from './settings/SyncSection';
import { CaptureSection }     from './settings/CaptureSection';
import { PreferencesSection } from './settings/PreferencesSection';

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

interface Props {
  prefs: UserPrefs;
  onToggleSource: (id: string) => void;
  onToggleTopic: (topic: Topic) => void;
  onResetPrefs: () => void;
  onClearViewed: () => void;
  onClose: () => void;
  onAddCustomSource: (source: CustomSource) => void;
  onRemoveCustomSource: (id: string) => void;
  onExportOPML: () => void;
  onImportOPML: (xml: string) => boolean;
  onExportBookmarks: () => void;
  onImportBookmarks: (html: string) => boolean;
  onAddLabel: (label: UserLabel) => void;
  onDeleteLabel: (labelId: string) => void;
  onSuggestLabels: (articles: Article[]) => Promise<string[]>;
  // Live sync
  syncActive: boolean;
  syncStatus: 'idle' | 'active' | 'syncing' | 'error';
  syncedAt: Date | null;
  syncError: string | null;
  syncErrorDetails: SyncErrorDetails | null;
  syncUrl: string | null;
  syncEnvError: string | null;
  // Shared article metadata
  metaStatus: MetaStatus;
  metaError: string | null;
  metaEnvError: string | null;
  onForceMetaSync: () => Promise<void>;
  onForceSync: () => Promise<void>;
  onGenerateLink: () => Promise<void>;
  onRevoke: () => Promise<void>;
  onToggleAiBar: () => void;
  onToggleTheme: () => void;
}

export function Settings({
  prefs, onToggleSource, onToggleTopic, onResetPrefs, onClearViewed, onClose,
  onAddCustomSource, onRemoveCustomSource, onExportOPML, onImportOPML,
  onExportBookmarks, onImportBookmarks,
  onAddLabel, onDeleteLabel, onSuggestLabels,
  syncActive, syncStatus, syncedAt, syncError, syncErrorDetails, syncUrl, syncEnvError,
  metaStatus, metaError, metaEnvError,
  onForceMetaSync, onForceSync, onGenerateLink, onRevoke, onToggleAiBar, onToggleTheme,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<Element | null>(null);

  // onClose is usually an inline arrow from App — keep it in a ref so this
  // effect never re-runs mid-session (a re-run steals focus from whatever
  // input the user is typing in).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    previousFocusRef.current = document.activeElement;
    panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onCloseRef.current(); return; }
      if (e.key === 'Tab' && panelRef.current) {
        const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last  = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      (previousFocusRef.current as HTMLElement | null)?.focus();
    };
  }, []); // mount-only: focus trap must not re-run while the modal is open

  return (
    <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="settings-panel" ref={panelRef}>
        <div className="settings-header">
          <h2>Customize Feed</h2>
          <button className="btn-close" onClick={onClose} aria-label="Close settings">✕</button>
        </div>

        <TopicsSection prefs={prefs} onToggleTopic={onToggleTopic} />

        <SourcesSection
          prefs={prefs}
          onToggleSource={onToggleSource}
          onAddCustomSource={onAddCustomSource}
          onRemoveCustomSource={onRemoveCustomSource}
          onExportOPML={onExportOPML}
          onImportOPML={onImportOPML}
          onExportBookmarks={onExportBookmarks}
          onImportBookmarks={onImportBookmarks}
        />

        <LabelsSection
          prefs={prefs}
          onAddLabel={onAddLabel}
          onDeleteLabel={onDeleteLabel}
          onSuggestLabels={onSuggestLabels}
        />

        <SyncSection
          syncActive={syncActive}
          syncStatus={syncStatus}
          syncedAt={syncedAt}
          syncError={syncError}
          syncErrorDetails={syncErrorDetails}
          syncUrl={syncUrl}
          syncEnvError={syncEnvError}
          metaStatus={metaStatus}
          metaError={metaError}
          metaEnvError={metaEnvError}
          onForceMetaSync={onForceMetaSync}
          onForceSync={onForceSync}
          onGenerateLink={onGenerateLink}
          onRevoke={onRevoke}
        />

        <CaptureSection />

        <PreferencesSection
          prefs={prefs}
          onToggleAiBar={onToggleAiBar}
          onToggleTheme={onToggleTheme}
          onClearViewed={onClearViewed}
          onResetPrefs={onResetPrefs}
          onClose={onClose}
        />
      </div>
    </div>
  );
}
