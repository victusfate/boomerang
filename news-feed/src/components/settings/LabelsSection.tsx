import { useState } from 'react';
import { isPromptApiAvailable } from '../../services/labelClassifier';
import type { Article, UserLabel, UserPrefs } from '../../types';

interface Props {
  prefs: UserPrefs;
  onAddLabel: (label: UserLabel) => void;
  onDeleteLabel: (labelId: string) => void;
  onSuggestLabels: (articles: Article[]) => Promise<string[]>;
}

export function LabelsSection({ prefs, onAddLabel, onDeleteLabel, onSuggestLabels }: Props) {
  const [newLabelName, setNewLabelName]   = useState('');
  const [newLabelColor, setNewLabelColor] = useState('#6c63ff');
  const [suggestions, setSuggestions]     = useState<string[]>([]);
  const [suggesting, setSuggesting]       = useState(false);

  const handleAddLabel = (e: React.FormEvent) => {
    e.preventDefault();
    const name = newLabelName.trim();
    if (!name) return;
    const id = `lbl-${Date.now().toString(36)}`;
    onAddLabel({ id, name, color: newLabelColor });
    setNewLabelName('');
    setNewLabelColor('#6c63ff');
  };

  const handleSuggest = async () => {
    setSuggesting(true);
    try {
      const results = await onSuggestLabels([]);
      setSuggestions(results);
    } catch (e) {
      console.error('[labels] suggest failed', e);
      setSuggestions([]);
    } finally {
      setSuggesting(false);
    }
  };

  const handleAcceptSuggestion = (name: string) => {
    const id = `lbl-${Date.now().toString(36)}`;
    onAddLabel({ id, name, color: '#6c63ff' });
    setSuggestions(prev => prev.filter(s => s !== name));
  };

  const handleDismissSuggestion = (name: string) => {
    setSuggestions(prev => prev.filter(s => s !== name));
  };

  return (
    <section className="settings-section">
      <h3>AI Labels</h3>
      <p className="settings-hint">
        {/* quality-ok: magic-number — Chrome minimum version with on-device Prompt API */}
        Create topic labels to tag your feed. On Chrome 138+, on-device AI classifies articles automatically.
      </p>

      {(prefs.userLabels ?? []).length > 0 && (
        <div className="label-list">
          {(prefs.userLabels ?? []).map(lbl => (
            <div key={lbl.id} className="label-list-item">
              <span className="label-list-dot" style={{ background: lbl.color }} />
              <span className="label-list-name">{lbl.name}</span>
              <button
                className="btn-remove-label"
                onClick={() => onDeleteLabel(lbl.id)}
                aria-label={`Delete label ${lbl.name}`}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <form className="add-label-form" onSubmit={handleAddLabel}>
        <input
          type="text"
          className="custom-source-input add-label-input"
          placeholder="New label name"
          value={newLabelName}
          onChange={e => setNewLabelName(e.target.value)}
          required
        />
        <input
          type="color"
          className="add-label-color"
          value={newLabelColor}
          onChange={e => setNewLabelColor(e.target.value)}
          title="Label colour"
        />
        <button type="submit" className="btn-add-source">Add</button>
      </form>

      {isPromptApiAvailable() && (
        <>
          <button
            type="button"
            className="btn-add-source"
            style={{ marginTop: '10px' }}
            onClick={handleSuggest}
            disabled={suggesting}
          >
            {suggesting ? 'Thinking…' : 'Suggest labels with AI'}
          </button>

          {suggestions.length > 0 && (
            <div className="suggestion-chips">
              {suggestions.map(name => (
                <div key={name} className="suggestion-chip">
                  <span className="suggestion-chip-name">{name}</span>
                  <button
                    className="btn-accept-suggestion"
                    onClick={() => handleAcceptSuggestion(name)}
                  >
                    + Add
                  </button>
                  <button
                    className="btn-dismiss-suggestion"
                    onClick={() => handleDismissSuggestion(name)}
                    aria-label={`Dismiss ${name}`}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
