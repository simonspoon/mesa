import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  closestCenter,
  DndContext,
  MouseSensor,
  pointerWithin,
  useSensor,
  useSensors,
  TouchSensor,
  type ClientRect,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
} from '@dnd-kit/core'
import { SortableContext, useSortable, type SortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  getGitStatus,
  listAllAgents,
  listProjects,
  listTasks,
  unarchiveProject,
  updateProject,
} from '../api'
import { dropIntentFor, zoneForOffset, type DropIntent, type DropZone } from '../navOrder'
import {
  expandAncestors,
  loadCollapsed,
  saveCollapsed,
  toggleCollapsed,
} from '../navCollapse'
import {
  ancestorIds,
  buildTree,
  effectivelyArchivedIds,
  hasChildren,
  todoCountFor,
  visibleRows,
} from '../projectTree'
import { ccHref, projectHref } from '../lastView'
import type { GitStatus } from '../types/GitStatus'
import type { Project } from '../types/Project'
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

/** The project id a `#/projects/:id/...` hash names, or null for any other
 *  route. Read straight off the URL rather than taken from the
 *  `activeProjectId` prop so the subtree reveal below is driven by the
 *  navigation event itself. */
function projectIdFromHash(hash: string): number | null {
  const id = Number(/^#\/projects\/(\d+)/.exec(hash)?.[1])
  return Number.isFinite(id) ? id : null
}

// CC Dashboard sub-pages, in nav order. The main "CC Dashboard" link goes to
// the *remembered* sub-page (task 694), so the overview (charts + KPIs) is a
// subnav row like the rest — its hash is the bare `#/cc`, there is no
// `#/cc/overview` segment (mesa task 699).
const CC_SUBNAV: { tab: CcTab; label: string; hash: string }[] = [
  { tab: 'overview', label: 'Overview', hash: '#/cc' },
  { tab: 'skills-agents', label: 'Skills / Agents', hash: '#/cc/skills-agents' },
  { tab: 'projects', label: 'Projects', hash: '#/cc/projects' },
  { tab: 'sessions', label: 'Sessions', hash: '#/cc/sessions' },
]

/**
 * Persistent left nav: four top-level entries sharing one `.nav-item` style —
 * the CC Dashboard, the global Inbox, Terminal, and Projects. The CC Dashboard
 * owns a fixed subnav of its sub-pages; Projects owns a subnav (the project
 * list + create form). Both collapse: Projects' row *is* the disclosure header,
 * while the CC Dashboard keeps its link and pairs it with a caret button
 * (mesa task 776). `ccTab` is the active CC sub-page (or null when off the dashboard)
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
 * The rows under the pointer stay exactly where they are while a project is
 * dragged (mesa task 669) — `verticalListSortingStrategy`'s shove-the-others-
 * aside preview is gone.
 *
 * That preview answers "which gap am I falling into", which was the only
 * question a drag could ask while it reordered siblings only. A drag can now
 * also nest, and the two questions have one answer each: the `drop-*` hint on
 * the hovered row. A list that also slid rows around would be a second,
 * sometimes contradicting, story about the same gesture — it cannot show
 * "becomes a child of this row" at all.
 */
const noDisplacement: SortingStrategy = () => null

/** The pointer's current Y, reconstructed from where the drag started plus
 *  how far it has moved — dnd-kit hands the move/end events a delta, not a
 *  position, and both mouse and touch starts have to work. `null` when the
 *  activator was neither (a synthetic event in a test, say). */
function pointerY(activatorEvent: Event, deltaY: number): number | null {
  if ('touches' in activatorEvent) {
    const touch = (activatorEvent as TouchEvent).touches[0]
    return touch ? touch.clientY + deltaY : null
  }
  const mouse = activatorEvent as MouseEvent
  return typeof mouse.clientY === 'number' ? mouse.clientY + deltaY : null
}

/** Where in the hovered row the drop is landing (task 669). Falls back to the
 *  dragged row's own centre when the pointer can't be reconstructed, so a drop
 *  always resolves to *some* zone rather than silently doing nothing. */
function zoneFor(event: DragMoveEvent | DragEndEvent, over: ClientRect): DropZone {
  const y =
    pointerY(event.activatorEvent, event.delta.y) ??
    (event.active.rect.current.translated
      ? event.active.rect.current.translated.top +
        event.active.rect.current.translated.height / 2
      : null)
  if (y === null) return 'into'
  return zoneForOffset(y - over.top, over.height)
}

/**
 * One draggable project row in the active list (mesa task 666).
 *
 * The drag listeners go on the `<li>`, not on a separate grip, so the whole
 * row is the handle — the same shape as a board card, and the reason the
 * sensors below carry activation thresholds: a plain click has to reach the
 * `<a>` inside and navigate.
 *
 * `hint` is the live drop feedback (task 669): an insertion line above or
 * below the row for a sibling drop, the row itself outlined for a nest-into.
 * It is only ever set on a drop that would actually write, so "nothing lights
 * up" is the readout for an impossible or no-op drop.
 */
function SortableProject({
  id,
  depth,
  hint,
  children,
}: {
  id: number
  depth: number
  hint: DropZone | null
  children: ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id })
  return (
    <li
      ref={setNodeRef}
      style={
        {
          transform: CSS.Transform.toString(transform),
          transition,
          // Nesting is an indent step per level (task 668), not nested
          // <ul>s: one flat sortable list is what lets dnd-kit reorder
          // siblings, and the whole row still has to be the drag handle.
          '--nav-depth': depth,
        } as CSSProperties
      }
      className={`nav-project-row${isDragging ? ' dragging' : ''}${
        hint ? ` drop-${hint}` : ''
      }`}
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
  // Guards the one-shot deep-link reveal below (task 668).
  const revealedRef = useRef(false)
  // One fetch, archived included (arch.md §"Spec 502" §4) — partitioned below
  // on `p.archived` so the main list and the archived group can never skew
  // against each other the way two separate requests could.
  const { data: allProjects, error, refetch } = useFetch(
    () =>
      listProjects(true).then((ps) => {
        // A deep link to a project inside a collapsed subtree: the tree isn't
        // knowable until the list lands, so the reveal rides along with it.
        // FIRST load only — this fetcher re-runs on refocus, and re-revealing
        // there would reopen a subtree the user has since collapsed by hand.
        if (!revealedRef.current) {
          revealedRef.current = true
          revealProject(ps, projectIdFromHash(window.location.hash))
        }
        return ps
      }),
    `projects-${version}`,
  )
  // Partitioned on EFFECTIVE visibility (task 668), not the raw `archived`
  // flag: the server hides a project from unscoped reads iff it or any
  // ancestor is archived, and the sidebar re-derives that same rule here —
  // otherwise a live child of an archived parent would sit in the main list
  // while `mesa project list` and every unscoped read omit it.
  const hiddenIds = effectivelyArchivedIds(allProjects ?? [])
  const projects = allProjects?.filter((p) => !hiddenIds.has(p.id))
  const archivedProjects = allProjects?.filter((p) => hiddenIds.has(p.id)) ?? []
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
  // Ephemeral collapse of the CC Dashboard subnav — same non-persisted pattern
  // as the two section headers below; `navCollapse.ts` localStorage is
  // reserved for the project subtrees the user curated themselves.
  const [ccCollapsed, setCcCollapsed] = useState(false)
  // Ephemeral collapse of the Projects subnav (persistence is a nice-to-have).
  const [projectsCollapsed, setProjectsCollapsed] = useState(false)
  // Ephemeral collapse of the archived group, same non-persisted pattern as
  // `projectsCollapsed` above — starts collapsed so a rarely-visited group
  // doesn't push the active project list down by default.
  const [archivedCollapsed, setArchivedCollapsed] = useState(true)
  const [unarchiveError, setUnarchiveError] = useState<string | null>(null)
  const [reorderError, setReorderError] = useState<string | null>(null)
  // Per-project subtree collapse (task 668) — persisted, unlike the two
  // section headers above: this is a nesting the user arranged themselves, and
  // having it spring open on every reload is what the persistence answers.
  const [collapsedIds, setCollapsedIds] = useState(loadCollapsed)
  function toggleSubtree(id: number): void {
    setCollapsedIds((c) => {
      const next = toggleCollapsed(c, id)
      saveCollapsed(next)
      return next
    })
  }

  // The rows to draw: the flat server array as a depth-annotated tree, minus
  // whatever sits inside a collapsed subtree.
  const rows = visibleRows(buildTree(projects ?? []), (id) => collapsedIds.has(id))

  // Landing on a project inside a collapsed subtree must reveal it —
  // highlighting a row nobody can see is worse than highlighting none.
  // `expandAncestors` returns the same set when there was nothing to open, so
  // the ordinary case writes no state and re-renders nothing.
  //
  // Called from the two places a landing actually happens — the project list
  // arriving (a deep link on first paint) and a hash change (navigation) —
  // rather than from an effect on `activeProjectId`: reacting to the prop
  // would also fire when the user *collapses* the subtree they are sitting
  // in, immediately reopening it and making the caret a dead control.
  function revealProject(list: Project[], id: number | null): void {
    if (id === null) return
    setCollapsedIds((c) => {
      const next = expandAncestors(c, ancestorIds(list, id))
      if (next !== c) saveCollapsed(next)
      return next
    })
  }

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

  // The pointer has to land on a ROW for the zone math to mean anything, so
  // resolve the collision by pointer position first; `closestCenter` only
  // catches the pointer straying into a gap between rows.
  const collisionDetection: CollisionDetection = (args) => {
    const under = pointerWithin(args)
    return under.length > 0 ? under : closestCenter(args)
  }

  // The drop the pointer is currently over, already validated: `null` when
  // the drop would write nothing (onto itself, into its own descendant, or
  // back where it started), which is also what suppresses the hint.
  function resolveDrop(
    event: DragMoveEvent | DragEndEvent,
  ): { id: number; overId: number; zone: DropZone; intent: DropIntent } | null {
    const { active, over } = event
    if (!over || !projects) return null
    const id = Number(active.id)
    const overId = Number(over.id)
    const zone = zoneFor(event, over.rect)
    // `projects` is already in server order (`ORDER BY sort_order, id`), which
    // is what `dropIntentFor` expects; all the drop math and the cycle check
    // live there, where vitest can reach them (task 669).
    const intent = dropIntentFor(projects, id, overId, zone)
    return intent === null ? null : { id, overId, zone, intent }
  }

  // Live feedback while dragging: which row, and which of its three bands.
  const [dropHint, setDropHint] = useState<{ id: number; zone: DropZone } | null>(null)

  function handleDragMove(event: DragMoveEvent) {
    const drop = resolveDrop(event)
    setDropHint((h) => {
      if (!drop) return h === null ? h : null
      return h?.id === drop.overId && h.zone === drop.zone ? h : { id: drop.overId, zone: drop.zone }
    })
  }

  // One drag = one PATCH carrying `parent_id` and `sort_order` together; no
  // other row is renumbered, and a null resolution means no request at all.
  function handleDragEnd(event: DragEndEvent) {
    setDropHint(null)
    const drop = resolveDrop(event)
    if (!drop) return
    // Nesting into a collapsed subtree would otherwise drop the row somewhere
    // invisible, so reveal the target before the list comes back.
    if (drop.zone === 'into') {
      setCollapsedIds((c) => {
        const next = expandAncestors(c, [drop.overId])
        if (next !== c) saveCollapsed(next)
        return next
      })
    }
    updateProject(drop.id, {
      parent_id: drop.intent.parent_id,
      sort_order: drop.intent.sort_order,
    }).then(
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
  // user has picked a destination so it doesn't sit over the new page. The
  // same listener reveals the destination's ancestors (task 668) — navigation
  // is the external event that should reopen a subtree, not a state change.
  useEffect(() => {
    const onNav = () => {
      if (isPhone()) setCollapsed(true)
      if (allProjects) revealProject(allProjects, projectIdFromHash(window.location.hash))
    }
    window.addEventListener('hashchange', onNav)
    return () => window.removeEventListener('hashchange', onNav)
  }, [setCollapsed, allProjects])

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
        {/* Unlike the Projects header this row stays an <a>: its href is the
            user's remembered CC tab (task 694), so the caret is a sibling
            button rather than the row itself. */}
        <div className="nav-item-row">
          <a
            className={`nav-item${ccTab !== null ? ' active' : ''}`}
            href={ccHref()}
          >
            <span className="nav-item-label">CC Dashboard</span>
          </a>
          <button
            type="button"
            className="nav-subtree-caret"
            aria-expanded={!ccCollapsed}
            aria-label={
              ccCollapsed ? 'Expand CC Dashboard pages' : 'Collapse CC Dashboard pages'
            }
            onClick={() => setCcCollapsed((c) => !c)}
          >
            {ccCollapsed ? '▸' : '▾'}
          </button>
        </div>
        {!ccCollapsed && (
          <ul className="nav-projects nav-subnav">
            {CC_SUBNAV.map((s) => (
              <li key={s.tab}>
                <a className={ccTab === s.tab ? 'active' : ''} href={s.hash}>
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
        )}
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
              <DndContext
                sensors={sensors}
                collisionDetection={collisionDetection}
                onDragMove={handleDragMove}
                onDragEnd={handleDragEnd}
                onDragCancel={() => setDropHint(null)}
              >
                <SortableContext
                  items={rows.map((r) => r.project.id)}
                  strategy={noDisplacement}
                >
                  <ul className="nav-projects">
                    {rows.map(({ project: p, depth }) => {
                      // Collapsed → the badge sums the subtree, so folding a
                      // parent away can never hide work (task 668).
                      const collapsed = collapsedIds.has(p.id)
                      const todo = todoCountFor(projects, todoCounts, p.id, collapsed)
                      return (
                        <SortableProject
                          key={p.id}
                          id={p.id}
                          depth={depth}
                          hint={dropHint?.id === p.id ? dropHint.zone : null}
                        >
                          {hasChildren(projects, p.id) ? (
                            <button
                              type="button"
                              className="nav-subtree-caret"
                              aria-expanded={!collapsed}
                              aria-label={
                                collapsed
                                  ? `Expand ${p.name}'s subprojects`
                                  : `Collapse ${p.name}'s subprojects`
                              }
                              // The row is the drag handle, so the caret has
                              // to keep its own click (and its own pointer
                              // press) away from the sensor above it.
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.stopPropagation()
                                toggleSubtree(p.id)
                              }}
                            >
                              {collapsed ? '▸' : '▾'}
                            </button>
                          ) : (
                            // A leaf keeps the caret's width so names down a
                            // level still line up with their siblings'.
                            <span className="nav-subtree-caret empty" aria-hidden="true" />
                          )}
                          <a
                            className={p.id === activeProjectId ? 'active' : ''}
                            href={projectHref(p.id)}
                          >
                            <span className="nav-project-name">{p.name}</span>
                            {activeAgentProjectIds.has(p.id) && (
                              <span className="live-dot on" title="agent running" />
                            )}
                            {todo > 0 && (
                              <span
                                className="inbox-badge todo-badge"
                                title={
                                  collapsed
                                    ? 'todo tasks in this project and its subprojects'
                                    : 'todo tasks in this project'
                                }
                              >
                                {todo}
                              </span>
                            )}
                            <GitLine git={gitByProject.get(p.id)} />
                          </a>
                        </SortableProject>
                      )
                    })}
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
                    {buildTree(archivedProjects).map(({ project: p, depth }) => (
                      <li
                        key={p.id}
                        style={{ '--nav-depth': depth } as CSSProperties}
                      >
                        <a
                          className={p.id === activeProjectId ? 'active' : ''}
                          href={projectHref(p.id)}
                        >
                          <span className="nav-project-name">{p.name}</span>
                        </a>
                        {/* `restore` belongs to the row that is actually
                            archived and whose own parent is not (task 668):
                            unarchiving it brings the whole subtree back in ONE
                            call, because the descendants were only ever hidden
                            by derivation — their rows were never written. A
                            live child listed under an archived root has
                            nothing of its own to restore. */}
                        {p.archived && (p.parent_id === null || !hiddenIds.has(p.parent_id)) && (
                          <button
                            type="button"
                            className="nav-unarchive-button"
                            title="Restore this project and everything under it to the main list"
                            onClick={() => handleUnarchive(p.id)}
                          >
                            restore
                          </button>
                        )}
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
