import { useState } from 'react'
import { createProject, listProjects } from '../api'
import { useFetch } from '../useFetch'

function CreateProjectForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    createProject(name, description === '' ? undefined : description).then(
      () => {
        setName('')
        setDescription('')
        setError(null)
        onCreated()
      },
      (err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
      },
    )
  }

  return (
    <form className="create-form" onSubmit={submit}>
      <input
        type="text"
        value={name}
        placeholder="new project name"
        required
        onChange={(e) => setName(e.target.value)}
      />
      <input
        type="text"
        value={description}
        placeholder="description (optional)"
        onChange={(e) => setDescription(e.target.value)}
      />
      <button type="submit">create</button>
      {error && <span className="error">{error}</span>}
    </form>
  )
}

export function ProjectsPage() {
  const { data: projects, error, refetch } = useFetch(() => listProjects(), 'projects')

  if (error) return <p className="error">{error}</p>
  if (!projects) return <p className="muted">Loading…</p>

  return (
    <>
      <h1>Projects</h1>
      <CreateProjectForm onCreated={refetch} />
      {projects.length === 0 ? (
        <p className="muted">No projects yet.</p>
      ) : (
        <ul className="card-list">
          {projects.map((p) => (
            <li key={p.id}>
              <a href={`#/projects/${p.id}`}>{p.name}</a>
              {p.description && <span className="muted"> — {p.description}</span>}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
