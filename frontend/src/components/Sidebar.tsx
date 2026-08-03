import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  getGitStatus,
  listAllAgents,
  listProjects,
  listTasks,
  unarchiveProject,
  updateProject,
} from '../api'
import { sortOrderForDrop } from '../navOrder'
import type { GitStatus } from '../types/GitStatus'
import type { CcTab } from '../pages/CCDashboardView'
import { isPhone } from '../phoneTier'
import { useFetch } from '../useFetch'
import { CreateProjectModal } from './CreateProjectModal'
import { isRunningAgent, projectForCwd } from '../agentProject'
import {
  clampNavWidth,
  clearNavWidth,
  DEFAULT_NAV_WIDTH,
  loadNavWidth,
  saveNavWidth,
} from '../navWidth'

// `main`'s own floor, mirroring MIN_MAIN_WIDTH in AgentSidebar.tsx: dragging
// the nav wide can never squeeze the content area to nothing. Measured live
// off `main`'s rect each move rather than assumed from the viewport, so it
// accounts for whatever the agent sidebar is currently taking.
const MIN_MAIN_WIDTH = 320

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
 * `.nav-footer` holds the machine-level entry — Settings — and is **sticky to
 * the bottom of the nav's scroll box**, not merely pushed there by
 * `margin-top: auto` (mesa task 654): a long project list scrolls underneath
 * it instead of carrying it out of view. Restart server used to sit here too;
 * it lives on the Settings page's title row now (mesa task 655), since it is
 * the same machine-level concern the page already owns.
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

/**
 * One draggable project row in the active list (mesa task 666).
 *
 * The drag listeners go on the `<li>`, not on a separate grip, so the whole
 * row is the handle — the same shape as a board card, and the reason the
 * sensors below carry activation thresholds: a plain click has to reach the
 * `<a>` inside and navigate.
 */
function SortableProject({ id, children }: { id: number; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id })
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`nav-project-row${isDragging ? ' dragging' : ''}`}
      {...listeners}
      {...attributes}
      // Same reasoning as the board's cards: dnd-kit's `attributes` add
      // `role="button"`/`tabIndex={0}` for a KeyboardSensor this list doesn't
      // configure, which would put a dead tab stop ahead of the real one (the
      // link). Tab and the `hjkl` spatial nav both belong to the <a>.
      tabIndex={-1}
    >
      {children}
    </li>
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
  const [reorderError, setReorderError] = useState<string | null>(null)

  // The board's sensor pair, and for the same two reasons (see KanbanBoard's
  // own comment): mouse gets a distance threshold so an ordinary click still
  // follows the project link, and touch gets a *delay* rather than a distance
  // so a vertical swipe scrolls the phone drawer natively instead of picking
  // a project up. The matching `touch-action: pan-y` is on `.nav-project-row`
  // in App.css.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  )

  // One drag = one PATCH of the dragged project's `sort_order`; the rows it
  // moved past keep the values they had. `projects` is already in server
  // order (`ORDER BY sort_order, id`), which is what `sortOrderForDrop`
  // expects, and a null result means the drop was a no-op — no request.
  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || !projects) return
    const id = Number(active.id)
    const sortOrder = sortOrderForDrop(projects, id, Number(over.id))
    if (sortOrder === null) return
    updateProject(id, { sort_order: sortOrder }).then(
      () => {
        setReorderError(null)
        refetch()
      },
      (e: unknown) => {
        setReorderError(e instanceof Error ? e.message : String(e))
      },
    )
  }

  // Drag-resize (mesa task 665), the mirror of the agent sidebar's own. The
  // width is applied as a custom property, never an inline `width`: at the
  // phone tier the expanded nav is a fixed-width overlay drawer, and an
  // inline width would beat that rule and hand a 390px screen a drag-width
  // drawer. Clamp bounds live in `navWidth.ts`; only the live ceiling is
  // measured here.
  const navRef = useRef<HTMLElement>(null)
  const [navWidth, setNavWidth] = useState(loadNavWidth)
  const [resizing, setResizing] = useState(false)

  // A stored width is loaded unclamped (navWidth.ts can't see the window), so
  // pull it into range once mounted and on every window resize — the state
  // must never *hold* an out-of-range value, not merely render as one.
  useEffect(() => {
    const clampToLayout = () => {
      const navLeft = navRef.current?.getBoundingClientRect().left
      const mainRight = document.querySelector('main')?.getBoundingClientRect().right
      if (navLeft === undefined || mainRight === undefined) return
      setNavWidth((w) => clampNavWidth(w, mainRight - navLeft - MIN_MAIN_WIDTH))
    }
    clampToLayout()
    window.addEventListener('resize', clampToLayout)
    return () => window.removeEventListener('resize', clampToLayout)
  }, [collapsed])

  // Listeners go on `document`, not the handle, so the drag keeps tracking
  // when the pointer outruns it. New width is the pointer's distance from the
  // nav's own left edge; the ceiling keeps `main` at least MIN_MAIN_WIDTH
  // wide. The <body> class matches `body.agent-sidebar-resizing` so a sweep
  // across the page doesn't select text under it.
  useEffect(() => {
    if (!resizing) return
    // The listeners live for the whole drag, so they'd close over the
    // `navWidth` this effect started with. `latest` carries the value forward
    // for `onUp` to persist without re-subscribing on every move. It stays
    // null until the pointer actually moves, so a press-and-release that
    // never dragged writes nothing.
    let latest: number | null = null
    const onMove = (e: MouseEvent) => {
      const navLeft = navRef.current?.getBoundingClientRect().left ?? 0
      const mainRight = document.querySelector('main')?.getBoundingClientRect().right
      if (mainRight === undefined) return
      latest = clampNavWidth(e.clientX - navLeft, mainRight - navLeft - MIN_MAIN_WIDTH)
      setNavWidth(latest)
    }
    // Persist on drag end only: once per drag, not once a frame. Written here
    // rather than from a `[navWidth]` effect so the double-click reset's
    // `clearNavWidth()` isn't immediately undone by a re-save of the default.
    const onUp = () => {
      setResizing(false)
      if (latest !== null) saveNavWidth(latest)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.classList.add('nav-resizing')
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.classList.remove('nav-resizing')
    }
  }, [resizing])

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
      <nav
        className="sidebar"
        ref={navRef}
        style={{ '--nav-width': `${navWidth}px` } as CSSProperties}
      >
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
              // Drag-reorder is scoped to this list alone (mesa task 666):
              // the archived group below renders in the same order but is
              // deliberately not sortable, so a drag can never carry a row
              // across the archive boundary and quietly mean "unarchive".
              <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
                <SortableContext
                  items={projects.map((p) => p.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <ul className="nav-projects">
                    {projects.map((p) => (
                      <SortableProject key={p.id} id={p.id}>
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
                      </SortableProject>
                    ))}
                  </ul>
                </SortableContext>
              </DndContext>
            )}
            {reorderError && <p className="error nav-archived-error">{reorderError}</p>}
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
      {/* Drag handle, a *sibling* flex item of `.shell-body` rather than a
          child of the nav (mesa task 665). The nav is a scroll box
          (`overflow-y: auto`), unlike `.agent-sidebar` — an absolutely
          positioned child would be clipped by it and would scroll away with
          the project list. A zero-width flex item stretched by
          `align-items: stretch`, with its hit area widened by negative
          margins, is full-height and clip-free. */}
      <div
        className={`nav-resize-handle${resizing ? ' resizing' : ''}`}
        onMouseDown={(e) => {
          e.preventDefault()
          setResizing(true)
        }}
        onDoubleClick={() => {
          setNavWidth(DEFAULT_NAV_WIDTH)
          clearNavWidth()
        }}
      />
    </>
  )
}
