import type { UserPrefs } from '../../types';

interface Props {
  prefs: UserPrefs;
  onToggleAiBar: () => void;
  onToggleTheme: () => void;
  onClearViewed: () => void;
  onResetPrefs: () => void;
  onClose: () => void;
}

export function PreferencesSection({ prefs, onToggleAiBar, onToggleTheme, onClearViewed, onResetPrefs, onClose }: Props) {
  return (
    <>
      <section className="settings-section">
        <h3>Preferences</h3>
        <p className="settings-hint">Clear viewed history to see previously read articles again.</p>
        <label className="settings-toggle-row">
          <input
            type="checkbox"
            checked={prefs.theme === 'dark'}
            onChange={onToggleTheme}
          />
          Dark mode
        </label>
        <label className="settings-toggle-row">
          <input
            type="checkbox"
            checked={!prefs.hideAiBar}
            onChange={onToggleAiBar}
          />
          Show Chrome AI bar
        </label>
        <button className="btn-reset-prefs" onClick={() => { onClearViewed(); onClose(); }}>
          Clear viewed history
        </button>
        <p className="settings-hint" style={{ marginTop: '12px' }}>
          Reset all learned weights from votes and reading history. Source and topic toggles are preserved.
        </p>
        <button className="btn-reset-prefs" onClick={() => { onResetPrefs(); onClose(); }}>
          Reset learned preferences
        </button>
      </section>

      <section className="settings-section">
        <h3>About</h3>
        <p className="settings-about">
          Boomerang News is an ad-free algorithmic news aggregator.
          Articles open in your default browser or native apps.
          All preferences are stored locally on your device — no account needed.
        </p>
        <p className="settings-about">
          <strong>Android setup:</strong> Install this as a PWA from your browser menu
          ("Add to Home Screen"), then configure your launcher to open it when swiping left.
        </p>
      </section>
    </>
  );
}
