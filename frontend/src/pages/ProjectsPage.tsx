import { listProjects } from '../api'
import { useFetch } from '../useFetch'

export function ProjectsPage() {
  const { data: projects, error } = useFetch(() => listProjects(), 'projects')

  if (error) return <p className="error">{error}</p>
  if (!projects) return <p className="muted">Loading…</p>

  return (
    <>
      <h1>Projects</h1>
      {projects.length === 0 ? (
        <p className="muted">
          No projects yet. Create one with <code>mesa project create</code>.
        </p>
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
