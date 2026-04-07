import { useState } from 'react'

function timeAgo(ts) {
  if (!ts) return ''
  const sec = Math.floor((Date.now() - ts) / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.floor(hr / 24)
  return `${d}d ago`
}

export default function IdeaCard({ doc, allStatuses, statusLabels, onMove, onDelete, onEdit }) {
  const otherStatuses = allStatuses.filter(s => s !== doc.status)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(doc.title)

  function handleEditSubmit(e) {
    e.preventDefault()
    if (draft.trim() && draft.trim() !== doc.title) {
      onEdit(doc, { title: draft.trim() })
    }
    setEditing(false)
  }

  function handleEditKeyDown(e) {
    if (e.key === 'Escape') {
      setDraft(doc.title)
      setEditing(false)
    }
  }

  return (
    <article className={`idea-card idea-card--energy-${doc.energy}`}>
      <div className="card-header">
        <span className="card-tag">{doc.tag}</span>
        <div className="card-energy" title={`Energy level ${doc.energy}/5`}>
          {Array.from({ length: 5 }, (_, i) => (
            <span key={i} className={i < doc.energy ? 'bolt active' : 'bolt'}>⚡</span>
          ))}
        </div>
      </div>

      {editing ? (
        <form onSubmit={handleEditSubmit}>
          <input
            className="card-edit-input"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={handleEditKeyDown}
            autoFocus
          />
          <div className="card-edit-actions">
            <button type="submit" className="edit-save-btn">Save</button>
            <button type="button" className="edit-cancel-btn" onClick={() => { setDraft(doc.title); setEditing(false) }}>Cancel</button>
          </div>
        </form>
      ) : (
        <>
          <p
            className="card-title"
            onClick={() => { setDraft(doc.title); setEditing(true) }}
            title="Click to edit"
          >{doc.title}</p>
          {doc.createdAt && <span className="card-time">{timeAgo(doc.createdAt)}</span>}
        </>
      )}

      <div className="card-actions">
        <div className="move-buttons">
          {otherStatuses.map(s => (
            <button
              key={s}
              className="move-btn"
              onClick={() => onMove(doc, s)}
              title={`Move to ${statusLabels[s]}`}
            >→ {statusLabels[s].replace(/^\S+\s/, '')}</button>
          ))}
        </div>
        <button
          className="delete-btn"
          onClick={() => onDelete(doc)}
          title="Delete idea"
        >✕</button>
      </div>
    </article>
  )
}
