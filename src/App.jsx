import { useFireproof } from 'use-fireproof'
import { useState } from 'react'
import Column from './components/Column.jsx'
import AddIdeaForm from './components/AddIdeaForm.jsx'

const STATUSES = ['in-flight', 'circling', 'landed']
const STATUS_LABELS = {
  'in-flight': '🪃 In Flight',
  'circling': '🔄 Circling',
  'landed': '✅ Landed',
}

const SAMPLE_IDEAS = [
  { title: 'Build a local-first notes app', tag: 'tech', energy: 5, status: 'in-flight' },
  { title: 'Learn to throw a real boomerang', tag: 'hobby', energy: 3, status: 'circling' },
  { title: 'Write blog post about Fireproof', tag: 'tech', energy: 4, status: 'in-flight' },
  { title: 'Read "Shape Up" methodology', tag: 'reading', energy: 2, status: 'landed' },
  { title: 'Try offline-first architecture', tag: 'tech', energy: 5, status: 'circling' },
  { title: 'Cook a new recipe this weekend', tag: 'hobby', energy: 3, status: 'landed' },
  { title: 'Sketch UI for side project', tag: 'design', energy: 4, status: 'in-flight' },
  { title: 'Review PR backlog', tag: 'work', energy: 2, status: 'circling' },
  { title: 'Explore WebAssembly basics', tag: 'tech', energy: 4, status: 'in-flight' },
  { title: 'Plan a weekend hike', tag: 'hobby', energy: 3, status: 'landed' },
]

export default function App() {
  const { database, useLiveQuery } = useFireproof('boomerang-ideas')
  const [tagFilter, setTagFilter] = useState('')
  const [seeding, setSeeding] = useState(false)

  // Each column is a separate live query — reactively updates on any database change
  const inFlightDocs = useLiveQuery('status', { key: 'in-flight' }).docs
  const circlingDocs  = useLiveQuery('status', { key: 'circling' }).docs
  const landedDocs    = useLiveQuery('status', { key: 'landed' }).docs

  // Live query for all ideas — used to derive tag list and total count
  const allDocs = useLiveQuery('type', { key: 'idea' }).docs

  const allTags = [...new Set(allDocs.map(d => d.tag).filter(Boolean))].sort()

  const filterByTag = (docs) =>
    tagFilter ? docs.filter(d => d.tag === tagFilter) : docs

  const columnDocs = {
    'in-flight': filterByTag(inFlightDocs),
    'circling':  filterByTag(circlingDocs),
    'landed':    filterByTag(landedDocs),
  }

  async function handleMove(doc, newStatus) {
    await database.put({ ...doc, status: newStatus })
  }

  async function handleDelete(doc) {
    await database.del(doc._id)
  }

  async function handleEdit(doc, changes) {
    await database.put({ ...doc, ...changes })
  }

  async function handleSeed() {
    setSeeding(true)
    for (const idea of SAMPLE_IDEAS) {
      await database.put({ ...idea, type: 'idea', createdAt: Date.now() })
    }
    setSeeding(false)
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-top">
          <h1>🪃 Boomerang</h1>
          <p className="tagline">Ideas that always come back — powered by Fireproof</p>
        </div>
        <div className="header-controls">
          <div className="tag-filter">
            <span>Filter:</span>
            <button
              className={`tag-btn ${tagFilter === '' ? 'active' : ''}`}
              onClick={() => setTagFilter('')}
            >All</button>
            {allTags.map(tag => (
              <button
                key={tag}
                className={`tag-btn ${tagFilter === tag ? 'active' : ''}`}
                onClick={() => setTagFilter(tag === tagFilter ? '' : tag)}
              >{tag}</button>
            ))}
          </div>
          <div className="header-actions">
            <span className="idea-count">{allDocs.length} ideas stored locally</span>
            {allDocs.length === 0 && (
              <button
                className="seed-btn"
                onClick={handleSeed}
                disabled={seeding}
              >{seeding ? 'Throwing...' : '🪃 Load sample ideas'}</button>
            )}
          </div>
        </div>
      </header>

      <AddIdeaForm database={database} />

      <main className="board">
        {STATUSES.map(status => (
          <Column
            key={status}
            status={status}
            label={STATUS_LABELS[status]}
            docs={columnDocs[status]}
            allStatuses={STATUSES}
            statusLabels={STATUS_LABELS}
            onMove={handleMove}
            onDelete={handleDelete}
            onEdit={handleEdit}
          />
        ))}
      </main>

      <footer className="app-footer">
        <p>
          Data lives in your browser via{' '}
          <a href="https://fireproof.storage" target="_blank" rel="noopener noreferrer">
            Fireproof
          </a>
          . Refresh the page — your ideas persist. No server required.
        </p>
      </footer>
    </div>
  )
}
