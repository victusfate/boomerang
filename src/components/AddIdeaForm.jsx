import { useState } from 'react'

const TAGS = ['tech', 'design', 'work', 'hobby', 'reading', 'other']

export default function AddIdeaForm({ database }) {
  const [title, setTitle] = useState('')
  const [tag, setTag] = useState('tech')
  const [energy, setEnergy] = useState(3)
  const [status, setStatus] = useState('in-flight')

  async function handleSubmit(e) {
    e.preventDefault()
    if (!title.trim()) return
    await database.put({
      type: 'idea',
      title: title.trim(),
      tag,
      energy,
      status,
      createdAt: Date.now(),
    })
    setTitle('')
    setEnergy(3)
  }

  return (
    <form className="add-form" onSubmit={handleSubmit}>
      <input
        className="idea-input"
        value={title}
        onChange={e => setTitle(e.target.value)}
        placeholder="What idea is flying through your head?"
      />
      <select value={tag} onChange={e => setTag(e.target.value)}>
        {TAGS.map(t => <option key={t} value={t}>{t}</option>)}
      </select>
      <div className="energy-select">
        {[1, 2, 3, 4, 5].map(n => (
          <button
            key={n}
            type="button"
            className={`energy-btn ${energy >= n ? 'active' : ''}`}
            onClick={() => setEnergy(n)}
            title={`Energy level ${n}`}
          >⚡</button>
        ))}
      </div>
      <select value={status} onChange={e => setStatus(e.target.value)}>
        <option value="in-flight">In Flight</option>
        <option value="circling">Circling</option>
        <option value="landed">Landed</option>
      </select>
      <button type="submit" className="add-btn">🪃 Throw it</button>
    </form>
  )
}
