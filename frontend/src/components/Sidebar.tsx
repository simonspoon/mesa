import { useState } from 'react'
import { createProject, listInbox, listProjects } from '../api'
import { useFetch } from '../useFetch'

/**
 * Persistent left nav: a global Inbox link above every project by name, plus a
 * compact create form. `version` is bumped by pages after project rename/delete
 * so the list refetches (it is part of the useFetch key). The inbox count
 * live-polls so the badge of items needing triage stays current as agents send.
 */
export function Sidebar({
  activeProjectId,
  inboxActive,
  version,
}: {
  activeProjectId: number | null
  inboxActive: boolean
  version: number
}) {
  const { data: projects, error, refetch } = useFetch(
    () => listProjects(),
    `projects-${version}`,
  )
  const { data: inbox } = useFetch(() => listInbox(), 'inbox-nav', {
    pollMs: 5000,
  })
  // Badge counts items still awaiting triage (no project assigned yet).
  const unassigned = inbox
    ? inbox.filter((i) => i.project_id === null).length
    : 0
  const [name, setName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  // Ephemeral collapse state (spec S9; persistence is a nice-to-have).
  const [collapsed, setCollapsed] = useState(false)

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
    <nav className={`sidebar${collapsed ? ' collapsed' : ''}`}>
      <button
        type="button"
        className="nav-toggle"
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand projects nav' : 'Collapse projects nav'}
        title={collapsed ? 'Expand projects nav' : 'Collapse projects nav'}
        onClick={() => setCollapsed((c) => !c)}
      >
        {collapsed ? '▸' : '◂'}
      </button>
      {!collapsed && (
        <>
          <a
            className={`nav-inbox${inboxActive ? ' active' : ''}`}
            href="#/inbox"
          >
            Inbox
            {unassigned > 0 && <span className="inbox-badge">{unassigned}</span>}
          </a>
          <h2 className="nav-heading">Projects</h2>
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
        </>
      )}
    </nav>
  )
}
