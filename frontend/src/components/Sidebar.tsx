import { useState } from 'react'
import { createProject, listProjects } from '../api'
import { useFetch } from '../useFetch'

/**
 * Persistent left nav: every project by name plus a compact create form.
 * `version` is bumped by pages after project rename/delete so the list
 * refetches (it is part of the useFetch key).
 */
export function Sidebar({
  activeProjectId,
  version,
}: {
  activeProjectId: number | null
  version: number
}) {
  const { data: projects, error, refetch } = useFetch(
    () => listProjects(),
    `projects-${version}`,
  )
  const [name, setName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    createProject(name).then(
      () => {
        setName('')
        setCreateError(null)
        refetch()
      },
      (err: unknown) => {
        setCreateError(err instanceof Error ? err.message : String(err))
      },
    )
  }

  return (
    <nav className="sidebar">
      <h2>Projects</h2>
      {error ? (
        <p className="error">{error}</p>
      ) : !projects ? (
        <p className="muted">Loading…</p>
      ) : projects.length === 0 ? (
        <p className="muted">No projects yet.</p>
      ) : (
        <ul className="nav-projects">
          {projects.map((p) => (
            <li key={p.id}>
              <a
                className={p.id === activeProjectId ? 'active' : ''}
                href={`#/projects/${p.id}`}
              >
                {p.name}
              </a>
            </li>
          ))}
        </ul>
      )}
      <form className="nav-create" onSubmit={submit}>
        <input
          type="text"
          value={name}
          placeholder="new project"
          required
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit">+</button>
      </form>
      {createError && <p className="error">{createError}</p>}
    </nav>
  )
}
