export default function IdeaCard({ doc, allStatuses, statusLabels, onMove, onDelete }) {
  const otherStatuses = allStatuses.filter(s => s !== doc.status)

  return (
    <article className={`idea-card idea-card--energy-${doc.energy}`}>
      <div className="card-header">
        <span className="card-tag">{doc.tag}</span>
        <div className="card-energy">
          {Array.from({ length: 5 }, (_, i) => (
            <span key={i} className={i < doc.energy ? 'bolt active' : 'bolt'}>⚡</span>
          ))}
        </div>
      </div>
      <p className="card-title">{doc.title}</p>
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
