import { useState } from 'react'
import { createProject, listInbox, listProjects } from '../api'
import { useFetch } from '../useFetch'

/**
 * Persistent left nav: three top-level entries sharing one `.nav-item` style —
 * the CC Dashboard, the global Inbox, and Projects. Projects owns a subnav (the
 * project list + create form), so its row is a disclosure header that collapses
 * its subnav. `version` is bumped by pages after project rename/delete so the
 * list refetches (it is part of the useFetch key). The inbox count live-polls so
 * the badge of items needing triage stays current as agents send.
 */
export function Sidebar({
  activeProjectId,
  inboxActive,
  ccActive,
  version,
}: {
  activeProjectId: number | null
  inboxActive: boolean
  ccActive: boolean
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
  // Ephemeral collapse of the Projects subnav (persistence is a nice-to-have).
  const [projectsCollapsed, setProjectsCollapsed] = useState(false)
  // Full-sidebar collapse: hides the whole nav to give the main content area
  // the extra width, leaving only a thin re-expand handle.
  const [collapsed, setCollapsed] = useState(false)

  if (collapsed) {
    return (
      <nav className="sidebar collapsed">
        <button
          type="button"
          className="sidebar-toggle"
          aria-label="Expand sidebar"
          title="Expand sidebar"
          onClick={() => setCollapsed(false)}
        >
          »
        </button>
      </nav>
    )
  }

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
      <button
        type="button"
        className="sidebar-toggle"
        aria-label="Collapse sidebar"
        title="Collapse sidebar"
        onClick={() => setCollapsed(true)}
      >
        «
      </button>
      <a className={`nav-item${ccActive ? ' active' : ''}`} href="#/cc">
        <span className="nav-item-label">CC Dashboard</span>
      </a>
      <a className={`nav-item${inboxActive ? ' active' : ''}`} href="#/inbox">
        <span className="nav-item-label">Inbox</span>
        {unassigned > 0 && <span className="inbox-badge">{unassigned}</span>}
      </a>
      <button
        type="button"
        className="nav-item nav-section"
        aria-expanded={!projectsCollapsed}
        onClick={() => setProjectsCollapsed((c) => !c)}
      >
        <span className="nav-item-label">Projects</span>
        <span className="nav-caret">{projectsCollapsed ? '▸' : '▾'}</span>
      </button>
      {!projectsCollapsed && (
        <>
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
