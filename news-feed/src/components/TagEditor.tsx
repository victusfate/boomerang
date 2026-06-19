import { useCallback, useState } from 'react';

interface Props {
  articleId: string;
  uniqueLabelNames: string[];
  onAddManualTag?: (articleId: string, tag: string) => void;
  onRemoveManualTag?: (articleId: string, tag: string) => void;
}

export function TagEditor({ articleId, uniqueLabelNames, onAddManualTag, onRemoveManualTag }: Props) {
  const [addingTag, setAddingTag] = useState(false);
  const [newTagText, setNewTagText] = useState('');

  const commitNewTag = useCallback(() => {
    const v = newTagText.trim();
    if (v && onAddManualTag) onAddManualTag(articleId, v);
    setNewTagText('');
    setAddingTag(false);
  }, [newTagText, onAddManualTag, articleId]);

  const handleTagInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter')  { e.preventDefault(); commitNewTag(); }
    if (e.key === 'Escape') { setNewTagText(''); setAddingTag(false); }
  };

  return (
    <div className="label-badges">
      {uniqueLabelNames.map(name => (
        <span key={name} className="label-badge">
          {name}
          {onRemoveManualTag && (
            <button
              className="label-badge-remove"
              onClick={(e) => { e.stopPropagation(); onRemoveManualTag(articleId, name); }}
              aria-label={`Remove tag ${name}`}
            >×</button>
          )}
        </span>
      ))}
      {onAddManualTag && (
        addingTag ? (
          <input
            className="label-badge-input"
            value={newTagText}
            onChange={e => setNewTagText(e.target.value)}
            onBlur={commitNewTag}
            onKeyDown={handleTagInputKeyDown}
            placeholder="tag…"
            autoFocus
            maxLength={30}
          />
        ) : (
          <button
            className="label-badge-add"
            onClick={() => setAddingTag(true)}
            aria-label="Add tag"
            title="Add tag"
          >+</button>
        )
      )}
    </div>
  );
}
