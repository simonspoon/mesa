import { useEffect, useState } from 'react'
import {
  getGitStatus,
  listAllAgents,
  listProjects,
  listTasks,
  restartServer,
  unarchiveProject,
} from '../api'
import type { GitStatus } from '../types/GitStatus'
import type { CcTab } from '../pages/CCDashboardView'
import { isPhone } from '../phoneTier'
import { useFetch } from '../useFetch'
import { ConfirmDelete } from './ConfirmDelete'
import { CreateProjectModal } from './CreateProjectModal'
import { isRunningAgent, projectForCwd } from '../agentProject'

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
const CC_SUBNAV: { tab: CcTab; label: string; hash: string }[] = [
  { tab: 'skills-agents', label: 'Skills / Agents', hash: '#/cc/skills-agents' },
  { tab: 'projects', label: 'Projects', hash: '#/cc/projects' },
  { tab: 'sessions', label: 'Sessions', hash: '#/cc/sessions' },
]

/**
 * Persistent left nav: four top-level entries sharing one `.nav-item` style —
 * the CC Dashboard, the global Inbox, Terminal, and Projects. The CC Dashboard
 * owns a fixed subnav of its sub-pages; Projects owns a subnav (the project
 * list + create form), so its row is a disclosure header that collapses its
 * subnav. `ccTab` is the active CC sub-page (or null when off the dashboard)
 * and drives which CC link is highlighted. `terminalActive` highlights the
 * Terminal link the same way `inboxActive` does — the page itself is a
 * permanent sibling mount in `App.tsx` (mesa task 396), not rendered here.
 * `version` is bumped by pages after project rename/delete so the list
 * refetches (it is part of the useFetch key). The inbox count live-polls so
 * the badge of items needing triage stays current as agents send.
 *
 * `.nav-footer` holds the two machine-level entries — Settings and Restart
 * server — and is **sticky to the bottom of the nav's scroll box**, not merely
 * pushed there by `margin-top: auto` (mesa task 654): a long project list
 * scrolls underneath it instead of carrying it out of view.
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
  settingsActive,
  terminalActive,
  ccTab,
  version,
  unassigned,
  collapsed,
  onCollapsedChange,
}: {
  activeProjectId: number | null
  inboxActive: boolean
  settingsActive: boolean
  terminalActive: boolean
  ccTab: CcTab | null
  version: number
  // Count of inbox items still awaiting triage, for the Inbox badge. Fetched
  // in `App.tsx` and shared with the phone tab bar's own badge so the two can
  // never disagree (task 556).
  unassigned: number
  // Full-sidebar collapse: hides the whole nav to give the main content area
  // the extra width, leaving only a thin re-expand handle — and at the phone
  // tier, the difference between a closed drawer and an open one. Owned by
  // `App.tsx` since the phone tab bar's "More" slot opens this drawer too.
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
}) {
  const setCollapsed = onCollapsedChange
  // One fetch, archived included (arch.md §"Spec 502" §4) — partitioned below
  // on `p.archived` so the main list and the archived group can never skew
  // against each other the way two separate requests could.
  const { data: allProjects, error, refetch } = useFetch(
    () => listProjects(true),
    `projects-${version}`,
  )
  const projects = allProjects?.filter((p) => !p.archived)
  const archivedProjects = allProjects?.filter((p) => p.archived) ?? []
  // Per-project todo counts for the project rows; polls like the inbox badge
  // so counts stay current as agents create/close tasks.
  const { data: todos, refetch: refetchTodos } = useFetch(
    () => listTasks({ status: 'todo' }),
    'todo-nav',
    { pollMs: 5000 },
  )
  const todoCounts = new Map<number, number>()
  for (const t of todos ?? []) {
    todoCounts.set(t.project_id, (todoCounts.get(t.project_id) ?? 0) + 1)
  }
  // Git status per project (branch + dirty/ahead/behind) under each name.
  // Server caches per folder, so a slower poll than the badges is plenty.
  const { data: gitStatuses, refetch: refetchGit } = useFetch(
    () => getGitStatus(),
    'git-nav',
    { pollMs: 10000 },
  )
  const gitByProject = new Map<number, GitStatus>()
  for (const g of gitStatuses ?? []) {
    gitByProject.set(g.project_id, g.git)
  }
  // Which projects have a live Claude Code agent session running under their
  // local_path, for the pulsing nav dot below. Same cwd→project prefix match
  // AgentSidebar uses to label sessions with their owning project.
  const { data: agents } = useFetch(() => listAllAgents(), 'agents-nav', {
    pollMs: 5000,
  })
  const activeAgentProjectIds = new Set<number>()
  if (projects) {
    for (const a of agents ?? []) {
      if (!isRunningAgent(a)) continue
      const p = projectForCwd(a.cwd, projects)
      if (p) activeAgentProjectIds.add(p.id)
    }
  }
  const [creatingProject, setCreatingProject] = useState(false)
  // Ephemeral collapse of the Projects subnav (persistence is a nice-to-have).
  const [projectsCollapsed, setProjectsCollapsed] = useState(false)
  // Ephemeral collapse of the archived group, same non-persisted pattern as
  // `projectsCollapsed` above — starts collapsed so a rarely-visited group
  // doesn't push the active project list down by default.
  const [archivedCollapsed, setArchivedCollapsed] = useState(true)
  const [unarchiveError, setUnarchiveError] = useState<string | null>(null)

  // On phones the expanded sidebar is an overlay drawer; close it once the
  // user has picked a destination so it doesn't sit over the new page.
  useEffect(() => {
    const onNav = () => {
      if (isPhone()) setCollapsed(true)
    }
    window.addEventListener('hashchange', onNav)
    return () => window.removeEventListener('hashchange', onNav)
  }, [setCollapsed])

  function handleUnarchive(id: number): void {
    setUnarchiveError(null)
    unarchiveProject(id)
      .then(() => {
        refetch()
        // The row's decorations come from their own fetches, and both of them
        // read the *unscoped* endpoints, which omit archived projects — so a
        // restored project has no todo count and no git line in the data
        // already on hand. Re-run them alongside the project list instead of
        // leaving the returned row bare until the next poll tick (task 509).
        refetchTodos()
        refetchGit()
      })
      .catch((e: unknown) => {
        setUnarchiveError(e instanceof Error ? e.message : String(e))
      })
  }
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

  return (
    <>
      {/* Phone-only scrim behind the drawer (mesa task 555). Rendered whenever
          the sidebar is expanded and hidden by CSS above 600px, so there is no
          second JS media query to keep in sync with App.css. It gives the
          drawer a tap-to-dismiss target and, via `touch-action: none`, stops a
          touch landing outside the drawer from scrolling `main` behind it. */}
      <div
        className="drawer-scrim"
        aria-hidden="true"
        onClick={() => setCollapsed(true)}
      />
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
        <a className={`nav-item${terminalActive ? ' active' : ''}`} href="#/terminal">
          <span className="nav-item-label">Terminal</span>
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
                      {activeAgentProjectIds.has(p.id) && (
                        <span className="live-dot on" title="agent running" />
                      )}
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
            {archivedProjects.length > 0 && (
              <>
                <button
                  type="button"
                  className="nav-item nav-section nav-subsection"
                  aria-expanded={!archivedCollapsed}
                  onClick={() => setArchivedCollapsed((c) => !c)}
                >
                  <span className="nav-item-label">
                    archived ({archivedProjects.length})
                  </span>
                  <span className="nav-caret">
                    {archivedCollapsed ? '▸' : '▾'}
                  </span>
                </button>
                {!archivedCollapsed && (
                  <ul className="nav-projects nav-archived">
                    {archivedProjects.map((p) => (
                      <li key={p.id}>
                        <a
                          className={p.id === activeProjectId ? 'active' : ''}
                          href={`#/projects/${p.id}`}
                        >
                          <span className="nav-project-name">{p.name}</span>
                        </a>
                        <button
                          type="button"
                          className="nav-unarchive-button"
                          title="Restore to the main project list"
                          onClick={() => handleUnarchive(p.id)}
                        >
                          restore
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {unarchiveError && <p className="error nav-archived-error">{unarchiveError}</p>}
              </>
            )}
            <button
              type="button"
              className="nav-create-button"
              onClick={() => setCreatingProject(true)}
            >
              + new project
            </button>
          </>
        )}
        <div className="nav-footer">
          <a
            className={`nav-item${settingsActive ? ' active' : ''}`}
            href="#/settings"
          >
            <span className="nav-item-label">Settings</span>
          </a>
          <ConfirmDelete
            label="Restart server"
            message="Relaunches mesa (picks up a rebuilt binary); reloads when it's back."
            onDelete={handleRestart}
          />
        </div>
        {creatingProject && (
          <CreateProjectModal
            onClose={() => setCreatingProject(false)}
            onCreated={() => {
              setCreatingProject(false)
              refetch()
            }}
          />
        )}
      </nav>
    </>
  )
}
