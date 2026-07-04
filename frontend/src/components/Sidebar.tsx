import { useEffect, useState } from 'react'
import { createProject, listInbox, listProjects, listTasks } from '../api'
import type { CcTab } from '../pages/CCDashboardView'
import { useFetch } from '../useFetch'

// CC Dashboard sub-pages, in nav order. The main "CC Dashboard" link is the
// overview (charts + KPIs); these are the table views split out beneath it.
// Phone-width check (matches the @media blocks in App.css): below this the
// expanded sidebar overlays the content as a drawer, so it starts collapsed
// and closes itself after navigation.
const isPhone = () => window.matchMedia('(max-width: 600px)').matches

const CC_SUBNAV: { tab: CcTab; label: string; hash: string }[] = [
  { tab: 'skills-agents', label: 'Skills / Agents', hash: '#/cc/skills-agents' },
  { tab: 'projects', label: 'Projects', hash: '#/cc/projects' },
  { tab: 'sessions', label: 'Sessions', hash: '#/cc/sessions' },
]

/**
 * Persistent left nav: three top-level entries sharing one `.nav-item` style —
 * the CC Dashboard, the global Inbox, and Projects. The CC Dashboard owns a
 * fixed subnav of its sub-pages; Projects owns a subnav (the project list +
 * create form), so its row is a disclosure header that collapses its subnav.
 * `ccTab` is the active CC sub-page (or null when off the dashboard) and drives
 * which CC link is highlighted. `version` is bumped by pages after project
 * rename/delete so the list refetches (it is part of the useFetch key). The
 * inbox count live-polls so the badge of items needing triage stays current as
 * agents send.
 */
export function Sidebar({
  activeProjectId,
  inboxActive,
  ccTab,
  version,
}: {
  activeProjectId: number | null
  inboxActive: boolean
  ccTab: CcTab | null
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
  // Per-project todo counts for the project rows; polls like the inbox badge
  // so counts stay current as agents create/close tasks.
  const { data: todos } = useFetch(() => listTasks({ status: 'todo' }), 'todo-nav', {
    pollMs: 5000,
  })
  const todoCounts = new Map<number, number>()
  for (const t of todos ?? []) {
    todoCounts.set(t.project_id, (todoCounts.get(t.project_id) ?? 0) + 1)
  }
  const [name, setName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  // Ephemeral collapse of the Projects subnav (persistence is a nice-to-have).
  const [projectsCollapsed, setProjectsCollapsed] = useState(false)
  // Full-sidebar collapse: hides the whole nav to give the main content area
  // the extra width, leaving only a thin re-expand handle.
  const [collapsed, setCollapsed] = useState(isPhone)

  // On phones the expanded sidebar is an overlay drawer; close it once the
  // user has picked a destination so it doesn't sit over the new page.
  useEffect(() => {
    const onNav = () => {
      if (isPhone()) setCollapsed(true)
    }
    window.addEventListener('hashchange', onNav)
    return () => window.removeEventListener('hashchange', onNav)
  }, [])

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
      <a
        className={`nav-item${ccTab === 'overview' ? ' active' : ''}`}
        href="#/cc"
      >
        <span className="nav-item-label">CC Dashboard</span>
      </a>
      <ul className="nav-projects nav-subnav">
        {CC_SUBNAV.map((s) => (
          <li key={s.tab}>
            <a className={ccTab === s.tab ? 'active' : ''} href={s.hash}>
              {s.label}
            </a>
          </li>
        ))}
      </ul>
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
                    <span className="nav-project-name">{p.name}</span>
                    {(todoCounts.get(p.id) ?? 0) > 0 && (
                      <span className="inbox-badge todo-badge">
                        {todoCounts.get(p.id)}
                      </span>
                    )}
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
