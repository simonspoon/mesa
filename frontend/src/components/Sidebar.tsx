import { useEffect, useState } from 'react'
import {
  createProject,
  getGitStatus,
  listInbox,
  listProjects,
  listTasks,
  restartServer,
} from '../api'
import type { GitStatus } from '../types/GitStatus'
import type { CcTab } from '../pages/CCDashboardView'
import { useFetch } from '../useFetch'
import { ConfirmDelete } from './ConfirmDelete'

/**
 * Polls the server with a cheap existing GET until it responds, for use after
 * `restartServer()` — the old process exits and a new one has to open the
 * store and rebind the port before anything answers again.
 */
async function waitForServer(timeoutMs = 15000, intervalMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
    try {
      await listProjects()
      return
    } catch {
      // Still shutting down or starting back up — keep polling.
    }
  }
  throw new Error(
    'server did not come back within 15s — check the terminal mesa is running in',
  )
}

async function handleRestart(): Promise<void> {
  await restartServer()
  await waitForServer()
  window.location.reload()
}

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
/**
 * One-line git summary under a project name: branch, a dirty marker with the
 * changed-path count, and ahead/behind arrows when an upstream is set.
 * Renders nothing when the project has no live repo.
 */
function GitLine({ git }: { git: GitStatus | undefined }) {
  if (!git) return null
  return (
    <span className="nav-git">
      <span className="nav-git-branch">{git.branch}</span>
      {git.dirty > 0 && <span className="nav-git-dirty">±{git.dirty}</span>}
      {git.ahead > 0 && <span>↑{git.ahead}</span>}
      {git.behind > 0 && <span>↓{git.behind}</span>}
    </span>
  )
}

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
  // Git status per project (branch + dirty/ahead/behind) under each name.
  // Server caches per folder, so a slower poll than the badges is plenty.
  const { data: gitStatuses } = useFetch(() => getGitStatus(), 'git-nav', {
    pollMs: 10000,
  })
  const gitByProject = new Map<number, GitStatus>()
  for (const g of gitStatuses ?? []) {
    gitByProject.set(g.project_id, g.git)
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
                    <GitLine git={gitByProject.get(p.id)} />
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
      <div className="nav-footer">
        <ConfirmDelete
          label="Restart server"
          message="Relaunches mesa (picks up a rebuilt binary); reloads when it's back."
          onDelete={handleRestart}
        />
      </div>
    </nav>
  )
}
