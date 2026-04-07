import IdeaCard from './IdeaCard.jsx'

export default function Column({ status, label, docs, allStatuses, statusLabels, onMove, onDelete }) {
  const totalEnergy = docs.reduce((sum, d) => sum + (d.energy || 0), 0)

  return (
    <section className={`column column--${status}`}>
      <div className="column-header">
        <h2>{label}</h2>
        <div className="column-stats">
          <span className="card-count">{docs.length}</span>
          {totalEnergy > 0 && (
            <span className="energy-total" title={`${totalEnergy} total energy`}>
              {'⚡'.repeat(Math.min(totalEnergy, 8))}
            </span>
          )}
        </div>
      </div>
      <div className="column-cards">
        {docs.length === 0 && (
          <p className="empty-hint">No ideas here yet</p>
        )}
        {docs.map(doc => (
          <IdeaCard
            key={doc._id}
            doc={doc}
            allStatuses={allStatuses}
            statusLabels={statusLabels}
            onMove={onMove}
            onDelete={onDelete}
          />
        ))}
      </div>
    </section>
  )
}
