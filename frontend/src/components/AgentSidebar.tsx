import { Fragment, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  DndContext,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { listAllAgents, listProjects, spawnProjectAgent } from '../api'
import { projectForCwd } from '../agentProject'
import * as ptyPool from '../lib/ptyPool'
import {
  axisPos,
  collectLeafIds,
  computeDropEdge,
  DEFAULT_RATIO,
  emptyRoot,
  findPathToLeaf,
  getNodeAtPath,
  MIN_PANE_PX,
  removeLeaf,
  replaceAtPath,
  resolveDrop,
  toggleDivider,
  type DropEdge,
  type LeafNode as PTLeafNode,
  type SplitNode as PTSplitNode,
} from '../lib/paneTree'
import type { AgentSession } from '../types/AgentSession'
import type { Project } from '../types/Project'
import { useFetch } from '../useFetch'
import { agentTerminalDescriptor } from './AgentTerminal'
import { PtySlot } from './PtySlot'

const MIN_WIDTH = 280
const DEFAULT_WIDTH = 448 // 28rem, matches the CSS fallback
// No fixed upper cap (unlike the old 720px ceiling) — but `main` still needs
// a floor, or dragging past it squeezes its content (the CC Dashboard's
// cards, etc.) into character-by-character wrapping rather than a clean
// overflow the browser would otherwise catch. Measured live off `main`'s own
// rect each move, not a hardcoded viewport fraction, so it tracks the left
// nav sidebar's actual width (collapsed or expanded) instead of assuming one.
const MIN_MAIN_WIDTH = 320

// Stable id for the one leaf whose content is the session list rather than
// an attached terminal — an `agentId` from `claude agents --json` is always
// a short opaque id with no fixed shape, so a `__`-wrapped sentinel can't
// collide with a real one.
const LIST_LEAF_ID = '__agent-list__'

// This sidebar's own `contentKind` union, narrowing the shared generic
// pane-tree types (`frontend/src/lib/paneTree.ts`, extracted in mesa task
// 395) to what's specific here — an attached agent terminal, or the
// permanent session-list pane. A local type alias, not a re-export, so
// every existing bare `LeafNode`/`SplitNode` reference below keeps working
// unchanged.
type AgentLeafKind = 'agent' | 'list'
type LeafNode = PTLeafNode<AgentLeafKind>
type SplitNode = PTSplitNode<AgentLeafKind>

// Always appended to root's own children, regardless of how deep/mixed the
// tree is elsewhere — the spec's stated default insertion point.
function insertLeaf(root: SplitNode, agentId: string): SplitNode {
  return replaceAtPath(root, [], (n) => ({
    ...n,
    children: [
      ...n.children,
      { ratio: DEFAULT_RATIO, node: { kind: 'leaf', contentKind: 'agent', id: agentId } },
    ],
  }))
}

// Seeds the one permanent session-list leaf if the tree doesn't already
// have one — called once at init and is otherwise a no-op, since nothing
// in the UI ever closes the list leaf (task 368: it's a pane like any
// other agent pane, just not a closable one — closing it would strand the
// sidebar with no way left to open an agent pane).
function ensureListLeaf(root: SplitNode): SplitNode {
  if (findPathToLeaf(root, LIST_LEAF_ID)) return root
  return replaceAtPath(root, [], (n) => ({
    ...n,
    children: [
      { ratio: DEFAULT_RATIO, node: { kind: 'leaf', contentKind: 'list', id: LIST_LEAF_ID } },
      ...n.children,
    ],
  }))
}

function agentLabel(a: AgentSession): string {
  return a.name ?? a.id ?? a.sessionId.slice(0, 8)
}

// Only projects with a linked folder can host a new session (`local_path`
// is where `claude --bg` runs) — filtered here so the picker never offers a
// choice the spawn call would just reject as `validation`.
function startableProjects(projects: Project[] | null | undefined): Project[] {
  return (projects ?? []).filter((p) => p.local_path !== null)
}

// The picker's initial selection: the in-focus project if it's startable,
// else the first startable project, else none (an empty picker with no
// linked project anywhere).
function defaultStartProjectId(projects: Project[] | null | undefined, activeProjectId: number | null): number | '' {
  const startable = startableProjects(projects)
  if (activeProjectId !== null && startable.some((p) => p.id === activeProjectId)) return activeProjectId
  return startable[0]?.id ?? ''
}

function startedAgo(ms: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${mins % 60}m ago`
  return `${Math.floor(hours / 24)}d ago`
}

type Bucket = 'BLOCKED' | 'ACTIVE' | 'DONE'

// `AgentSession` carries no completion timestamp (only `startedAt`, the
// session's start time) — `claude agents --json` doesn't report one. DONE is
// sorted by `startedAt` desc as the closest available proxy for "most
// recently completed"; the bucketing itself is exact, driven by `state`.
function bucketOf(a: AgentSession): Bucket {
  if (a.state === 'blocked') return 'BLOCKED'
  if (a.state === 'done' || a.state === 'failed' || a.state === 'stopped') return 'DONE'
  return 'ACTIVE' // 'working', or no state at all (interactive sessions)
}

const BUCKETS: Bucket[] = ['BLOCKED', 'ACTIVE', 'DONE']

/**
 * One pane's chrome inside the split view: a header (drag handle + label +
 * optional extra badge + optional close) over arbitrary content. `ratio` is
 * this pane's share of the stack's flex space (see `AgentSidebar`'s
 * divider-drag comment) — sortable via dnd-kit via `dragId`, so every pane
 * (an attached agent terminal or the session list) is rearrangeable by
 * dragging the header's grip the same way.
 *
 * `onClose` is optional: the session-list pane has none (task 368 — it's a
 * permanent leaf, since closing it would strand the sidebar with no way
 * left to open an agent pane), every agent pane has one.
 */
function PaneShell({
  dragId,
  label,
  headerExtra,
  ratio,
  onClose,
  dropEdge,
  children,
}: {
  dragId: string
  label: string
  headerExtra?: ReactNode
  ratio: number
  onClose?: () => void
  // Set only while a drag is hovering an edge zone of THIS pane — renders
  // the split-preview overlay below. `null`/absent covers both "no drag in
  // progress" and "hovering this pane's own center zone" (reorder, no new
  // split, nothing to preview).
  dropEdge?: DropEdge | null
  children: ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: dragId,
  })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    flexGrow: ratio,
    flexBasis: 0,
    // Whichever axis flexbox distributes (main axis) is the one that needs
    // flooring to 0, and that axis flips with the parent split's
    // orientation (row vs column) — zeroing both defensively is cheaper
    // than branching on orientation and has no downside.
    minWidth: 0,
    minHeight: 0,
  }
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`agent-sidebar-pane${isDragging ? ' dragging' : ''}`}
    >
      <div className="agent-terminal-header">
        <span className="agent-sidebar-pane-title">
          <span className="agent-sidebar-pane-grip" {...listeners} {...attributes}>
            ⠿
          </span>
          <span>{label}</span>
          {headerExtra}
        </span>
        {onClose && <button onClick={onClose}>close</button>}
      </div>
      {children}
      {dropEdge && <div className={`agent-sidebar-pane-drop-indicator agent-sidebar-pane-drop-indicator-${dropEdge}`} />}
    </div>
  )
}

/**
 * One open agent's pane: `PaneShell` over its own `PtySlot` (mesa task 399
 * / .scratch/arch.md §6.2) — the actual `PtyTerminal` lives in the
 * always-mounted `PtyPool`, keyed by `agentId`; this just relocates its
 * stable container to this tree position, so a split/move reparent never
 * remounts (or reconnects) it.
 */
function AgentPane({
  agentId,
  label,
  ratio,
  onClose,
  dropEdge,
}: {
  agentId: string
  label: string
  ratio: number
  onClose: () => void
  dropEdge?: DropEdge | null
}) {
  const { endpoint, closedMessage } = agentTerminalDescriptor(agentId)
  return (
    <PaneShell dragId={agentId} label={label} ratio={ratio} onClose={onClose} dropEdge={dropEdge}>
      <PtySlot id={agentId} endpoint={endpoint} closedMessage={closedMessage} />
    </PaneShell>
  )
}

/** Props the session-list pane needs from `AgentSidebar`'s own state/data —
 * bundled into one object so `SplitNodeView` (module-scope, see its own
 * comment) can thread it down without widening its per-callback prop list. */
type ListPaneProps = {
  agents: AgentSession[]
  sessionsLoaded: boolean
  error: string | null
  projects: Project[] | null | undefined
  openIds: string[]
  collapsedSections: Record<Bucket, boolean>
  onToggleSection: (bucket: Bucket) => void
  onTogglePane: (agentId: string) => void
}

/** The session list itself, as a pane (task 368) — same `PaneShell` chrome
 * as an agent pane, just not closable and with the bucketed session list as
 * its body instead of a terminal. */
function AgentListPane({ ratio, list, dropEdge }: { ratio: number; list: ListPaneProps; dropEdge?: DropEdge | null }) {
  const { agents, sessionsLoaded, error, projects, openIds, collapsedSections, onToggleSection, onTogglePane } =
    list
  return (
    <PaneShell
      dragId={LIST_LEAF_ID}
      label="Agents"
      headerExtra={agents.length > 0 ? <span className="agent-sidebar-count">{agents.length}</span> : null}
      ratio={ratio}
      dropEdge={dropEdge}
    >
      <div className="agent-sidebar-list">
        {error && !sessionsLoaded ? (
          <p className="error">{error}</p>
        ) : !sessionsLoaded ? (
          <p className="muted">Loading…</p>
        ) : agents.length === 0 ? (
          <p className="muted">No agents running.</p>
        ) : (
          BUCKETS.map((bucket) => {
            const bucketAgents = agents.filter((a) => bucketOf(a) === bucket)
            if (bucketAgents.length === 0) return null
            const sectionCollapsed = collapsedSections[bucket]
            return (
              <div key={bucket} className="agent-sidebar-section">
                <button
                  type="button"
                  className="agent-sidebar-section-head"
                  aria-expanded={!sectionCollapsed}
                  onClick={() => onToggleSection(bucket)}
                >
                  <span className="agent-sidebar-section-caret">{sectionCollapsed ? '▸' : '▾'}</span>
                  {bucket}
                  <span className="agent-sidebar-count">{bucketAgents.length}</span>
                </button>
                {!sectionCollapsed && (
                  <ul className="card-list agent-list">
                    {bucketAgents.map((a) => {
                      const proj = projectForCwd(a.cwd, projects ?? [])
                      return (
                        <li
                          key={a.sessionId}
                          className={
                            (a.id !== null ? 'attachable' : '') +
                            (a.id !== null && openIds.includes(a.id) ? ' selected' : '')
                          }
                          onClick={() => {
                            if (a.id !== null) onTogglePane(a.id)
                          }}
                        >
                          <span className="agent-name">{agentLabel(a)}</span>
                          <span className={`badge agent-kind-${a.kind}`}>{a.kind}</span>
                          {a.status && <span className={`badge agent-status-${a.status}`}>{a.status}</span>}
                          {a.state && a.state !== a.status && (
                            <span className={`badge agent-state-${a.state}`}>{a.state}</span>
                          )}
                          {a.waitingFor && <span className="badge blocked">{a.waitingFor}</span>}
                          <div className="muted agent-meta">
                            {proj ? proj.name : a.cwd} · started {startedAgo(a.startedAt)}
                            {a.id === null && ' · external terminal — not attachable'}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            )
          })
        )}
      </div>
    </PaneShell>
  )
}

/**
 * Recursively renders one split node's own direct children as a flex
 * container (row or column per `node.orientation`) — nesting happens
 * *across* `SplitNodeView` instances (a nested split renders inside a
 * ratio-bearing wrapper div that is itself one flex item of the parent),
 * never within one instance's children, because flex-grow ratios only
 * compete among true flex siblings.
 *
 * Declared at module scope (not inside `AgentSidebar`) deliberately: an
 * open pane's `PtySlot` (and the `PtyTerminal` it relocates into this tree
 * position, mesa task 399) must survive every re-render (poll tick, resize
 * drag, collapse/expand) with no reconnect. A component nested inside
 * `AgentSidebar`'s body would get a new identity — and remount every
 * `PtySlot` beneath it — on every one of those re-renders. (A *reparent*,
 * as opposed to a same-identity re-render, is the separate case
 * `ptyPool.ts`/`PtySlot.tsx` handle: the pool container survives that too,
 * but via relocation, not via this component staying module-scope.)
 */
function SplitNodeView({
  node,
  path,
  agents,
  listProps,
  onClose,
  onDividerMouseDown,
  onDividerToggle,
  dropZone,
}: {
  node: SplitNode
  path: number[]
  agents: AgentSession[]
  listProps: ListPaneProps
  onClose: (agentId: string) => void
  onDividerMouseDown: (
    path: number[],
    i: number,
    orientation: 'row' | 'column',
    startPos: number,
    container: HTMLDivElement,
  ) => void
  onDividerToggle: (path: number[], i: number) => void
  // Which pane (if any) is currently a drag's edge-zone drop target, and
  // which edge — threaded down so the ONE leaf it names renders the
  // split-preview overlay (`PaneShell`'s `dropEdge`) without every other
  // pane needing to know a drag is even happening.
  dropZone: { id: string; edge: DropEdge } | null
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const leafIds = node.children.filter((c) => c.node.kind === 'leaf').map((c) => (c.node as LeafNode).id)
  const strategy = node.orientation === 'row' ? horizontalListSortingStrategy : verticalListSortingStrategy

  return (
    <SortableContext items={leafIds} strategy={strategy}>
      <div ref={containerRef} className={`agent-sidebar-panes agent-sidebar-panes-${node.orientation}`}>
        {node.children.map((child, i) => (
          <Fragment key={child.node.id}>
            {child.node.kind === 'leaf' ? (
              child.node.contentKind === 'list' ? (
                <AgentListPane
                  ratio={child.ratio}
                  list={listProps}
                  dropEdge={dropZone && dropZone.id === child.node.id ? dropZone.edge : null}
                />
              ) : (
                <AgentPane
                  agentId={child.node.id}
                  label={(() => {
                    // `contentKind` is a plain union-typed field on a single
                    // object shape here (paneTree.ts's `LeafNode<K>` isn't a
                    // discriminated union across shapes), so there's no
                    // per-variant `id` type to narrow to — just read
                    // `child.node.id` directly, valid for either contentKind.
                    const session = agents.find((a) => a.id === child.node.id)
                    return session ? agentLabel(session) : child.node.id
                  })()}
                  ratio={child.ratio}
                  onClose={() => onClose(child.node.id)}
                  dropEdge={dropZone && dropZone.id === child.node.id ? dropZone.edge : null}
                />
              )
            ) : (
              <div
                className="agent-sidebar-split-wrapper"
                style={{ display: 'flex', flexGrow: child.ratio, flexBasis: 0, minWidth: 0, minHeight: 0 }}
              >
                <SplitNodeView
                  node={child.node}
                  path={[...path, i]}
                  agents={agents}
                  listProps={listProps}
                  onClose={onClose}
                  onDividerMouseDown={onDividerMouseDown}
                  onDividerToggle={onDividerToggle}
                  dropZone={dropZone}
                />
              </div>
            )}
            {i < node.children.length - 1 && (
              <div
                className={`agent-sidebar-pane-divider agent-sidebar-pane-divider-${node.orientation}`}
                onMouseDown={(e) => {
                  // Belt-and-suspenders with the toggle button's own
                  // stopPropagation: mousedown fires before click, so if the
                  // toggle button is the target, don't also start a resize
                  // drag on the same gesture.
                  if ((e.target as HTMLElement).closest('.agent-sidebar-divider-toggle')) return
                  e.preventDefault()
                  const container = containerRef.current
                  if (!container) return
                  onDividerMouseDown(path, i, node.orientation, axisPos(e, node.orientation), container)
                }}
              >
                <button
                  type="button"
                  className="agent-sidebar-divider-toggle"
                  aria-label={
                    node.orientation === 'row' ? 'Split panes stacked' : 'Split panes side-by-side'
                  }
                  title={
                    node.orientation === 'row' ? 'Split panes stacked' : 'Split panes side-by-side'
                  }
                  onClick={(e) => {
                    // Stop this click from also reaching anything that
                    // treats the divider as a resize-drag surface — the
                    // toggle and the resize-drag share the same element by
                    // design (arch doc §6), so this is the one thing that
                    // keeps them from double-firing on the same gesture.
                    e.stopPropagation()
                    onDividerToggle(path, i)
                  }}
                >
                  {node.orientation === 'row' ? '⬍' : '⬌'}
                </button>
              </div>
            )}
          </Fragment>
        ))}
      </div>
    </SortableContext>
  )
}

/**
 * Global, persistent right-hand sidebar: every live Claude Code session
 * across every project, with room to attach one pane per selected session.
 * Rendered once in `App.tsx`, outside the router — it never unmounts on
 * navigation, so collapsing it only changes CSS (width), never the React
 * tree. That is load-bearing: each open pane's `PtyTerminal` (relocated
 * here via `PtySlot`, mesa task 399) owns a WebSocket, and it must survive
 * a collapse/expand cycle with no reconnect, exactly like leaving the tab
 * and coming back — now true for every open pane, not just one.
 */
export function AgentSidebar({ activeProjectId }: { activeProjectId: number | null }) {
  const [collapsed, setCollapsed] = useState(true)
  // Split tree holding every open pane + how each split's children share its
  // flex space. Root is always a SplitNode, never a bare leaf/null; the
  // session-list leaf is seeded in once up front (task 368 — it's a pane
  // like any other, just permanent) so with no other toggle or divider
  // ever used it stays a single-child column: one flex container, column
  // direction, the list pane alone. A session toggles its own leaf in/out
  // of the tree by clicking it inside the list pane; dragging a pane's
  // grip (including the list pane's own) reorders it among its split
  // siblings (dnd-kit sortable).
  const [root, setRoot] = useState<SplitNode>(() => ensureListLeaf(emptyRoot()))
  // DONE starts collapsed (stale sessions aren't the thing you want to see
  // first); BLOCKED/ACTIVE start open. `state` from the API is a live status
  // (working/blocked/done/…), not the `collapsed` UI concept below.
  const [collapsedSections, setCollapsedSections] = useState<Record<Bucket, boolean>>({
    BLOCKED: false,
    ACTIVE: false,
    DONE: true,
  })
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const [resizing, setResizing] = useState(false)
  // Maximized: the panel grows to fill the whole main content area (in place
  // of the fixed drag-resized width), matching the storyboard canvas's own
  // takeover-view expand toggle. Distinct from `collapsed` — maximized only
  // has an effect while the panel isn't collapsed.
  const [maximized, setMaximized] = useState(false)
  // Auto Tile: while on, the effect below keeps the pane tree in sync with
  // agent state instead of requiring a click per open/close — a pane opens
  // for every attachable session that's ACTIVE or BLOCKED (mesa task 411:
  // blocked agents need attention most, so they auto-open too, not just
  // ACTIVE) and closes the moment its session reaches DONE. Off by default;
  // switching it on syncs immediately against whatever `sessions` already
  // holds, since the effect depends on `autoTile` itself.
  const [autoTile, setAutoTile] = useState(false)

  // "Add Agent" form: a transient overlay row above the pane tree, not part
  // of it — it starts a session, it isn't one. `open` is a plain boolean
  // rather than the presence of a project id, so cancel/collapse can reset
  // it without losing the distinction between "closed" and "closed with
  // nothing chosen yet".
  const [addOpen, setAddOpen] = useState(false)
  const [addProjectId, setAddProjectId] = useState<number | ''>('')
  const [addPrompt, setAddPrompt] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  // Bumped by closeAddAgent and every new submit — a submit's `.then`/`.catch`
  // only applies its result if this still matches the id it captured, so
  // canceling (or reopening the form for a different project) before a spawn
  // resolves can't have the stale response clobber whatever the form shows
  // by the time it lands. The project-id ref below guards
  // against the analogous stale-async-write problem.
  const addRequestId = useRef(0)

  // Set while dragging a divider between two adjacent children of the split
  // node at `path`; `i` is the index of the upper/left one (the divider sits
  // between `children[i]` and `children[i+1]`). Captured once at mousedown
  // so the drag reads as a delta from a stable baseline rather than
  // accumulating rounding error. `startPos`/`containerSize` are axis-generic
  // (clientX/width for a row split, clientY/height for a column split) —
  // `axisPos` and `startDivider` below read/measure whichever axis
  // `orientation` says to, at any depth in the tree.
  const [paneDrag, setPaneDrag] = useState<null | {
    path: number[]
    i: number
    orientation: 'row' | 'column'
    startPos: number
    startA: number
    startB: number
    containerSize: number
  }>(null)

  // Which pane a pane-drag (dnd-kit, not the divider drag above) is
  // currently hovering an edge zone of, and which edge — drives the
  // split-preview overlay only; the actual split-vs-reorder decision is
  // recomputed independently at drop time (`handlePaneDragEnd`) straight
  // off that event's own pointer position, so this state can never go
  // stale relative to the decision it's only previewing.
  const [dropZone, setDropZone] = useState<null | { id: string; edge: DropEdge }>(null)

  // The pointer's own viewport position at drag start (`activatorEvent`,
  // only available there — `DragMoveEvent`/`DragEndEvent` carry `delta`
  // relative to it but not an absolute position of their own). A ref, not
  // state: written once per drag in `onDragStart` and only ever read
  // inside the same drag's later move/end handlers, so it never needs to
  // drive a render itself.
  const dragOriginRef = useRef<{ x: number; y: number } | null>(null)

  const sensors = useSensors(
    // distance: 4 lets plain clicks on the grip still register as clicks,
    // matching KanbanBoard's card-drag threshold.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  )

  // Escape leaves maximized mode — the usual way out of a takeover view,
  // same convention as the storyboard canvas. Only bound while maximized so
  // it never swallows Escape elsewhere.
  useEffect(() => {
    if (!maximized) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMaximized(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [maximized])

  // Drag-resize: the handle sits on the sidebar's left edge, so the new
  // width is just the distance from the pointer to the right edge of the
  // viewport. Listeners live on `document`, not the handle, so the drag
  // keeps tracking even when the pointer outruns the handle mid-drag.
  useEffect(() => {
    if (!resizing) return
    const onMove = (e: MouseEvent) => {
      const next = window.innerWidth - e.clientX
      const mainLeft = document.querySelector('main')?.getBoundingClientRect().left ?? 0
      const max = window.innerWidth - mainLeft - MIN_MAIN_WIDTH
      setWidth(Math.min(max, Math.max(MIN_WIDTH, next)))
    }
    const onUp = () => setResizing(false)
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.classList.add('agent-sidebar-resizing')
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.classList.remove('agent-sidebar-resizing')
    }
  }, [resizing])

  // Divider drag: converts a pixel delta into a ratio delta relative to the
  // two adjacent children's combined ratio, so the same drag distance feels
  // consistent regardless of how many siblings that split has or their
  // current split. Scoped to the split node at `paneDrag.path` — resizing
  // one split's divider never touches any other split's ratios.
  useEffect(() => {
    if (!paneDrag) return
    const onMove = (e: MouseEvent) => {
      if (paneDrag.containerSize <= 0) return
      const pos = axisPos(e, paneDrag.orientation)
      const sum = paneDrag.startA + paneDrag.startB
      const deltaRatio = ((pos - paneDrag.startPos) / paneDrag.containerSize) * sum
      const minRatio = (MIN_PANE_PX / paneDrag.containerSize) * sum
      const nextA = Math.min(sum - minRatio, Math.max(minRatio, paneDrag.startA + deltaRatio))
      setRoot((r) =>
        replaceAtPath(r, paneDrag.path, (n) => ({
          ...n,
          children: n.children.map((c, idx) => {
            if (idx === paneDrag.i) return { ...c, ratio: nextA }
            if (idx === paneDrag.i + 1) return { ...c, ratio: sum - nextA }
            return c
          }),
        })),
      )
    }
    const onUp = () => setPaneDrag(null)
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.classList.add('agent-sidebar-resizing')
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.classList.remove('agent-sidebar-resizing')
    }
  }, [paneDrag])

  // Only poll while expanded — collapsed, nobody can see the list, and each
  // poll costs a `claude agents` subprocess. The one-off fetch on expand (via
  // the pollMs change below) keeps it fresh the moment it's opened again.
  const { data: sessions, error, refetch } = useFetch(
    () => listAllAgents(),
    'agents-sidebar',
    { pollMs: collapsed ? undefined : 3000 },
  )
  const { data: projects } = useFetch(() => listProjects(), 'agents-sidebar-projects')

  // Auto Tile sync: reacts to `sessions` (not the per-render sorted `agents`
  // copy below, which would re-run this every render) so it only fires when
  // the poll actually returns new data — `useFetch` drops byte-identical
  // polls. Only touches attachable sessions (`a.id !== null`; interactive
  // sessions have no pane to open). Depending on `autoTile` itself makes
  // switching it on sync immediately against whatever `sessions` already
  // holds, not just future transitions. `ptyPool.remove` below is a real
  // side effect (kills the pooled terminal), so this must run as an effect,
  // not a render-time derivation.
  useEffect(() => {
    if (!autoTile || !sessions) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing pane tree to external poll data + a toggle, not derivable at render time
    setRoot((r) => {
      let next = r
      const openIds = new Set(collectLeafIds(next))
      for (const a of sessions) {
        if (a.id === null) continue
        const bucket = bucketOf(a)
        const isOpen = openIds.has(a.id)
        if ((bucket === 'ACTIVE' || bucket === 'BLOCKED') && !isOpen) {
          next = insertLeaf(next, a.id)
          openIds.add(a.id)
        } else if (bucket === 'DONE' && isOpen) {
          ptyPool.remove(a.id)
          next = removeLeaf(next, a.id)
          openIds.delete(a.id)
        }
      }
      return next
    })
  }, [autoTile, sessions])

  // Relative "started Xm ago" labels are derived from the clock at render
  // time, but useFetch drops byte-identical polls, so an idle list would
  // never re-render and the labels would freeze.
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 30000)
    return () => clearInterval(t)
  }, [])

  const agents = [...(sessions ?? [])].sort((a, b) => b.startedAt - a.startedAt)
  const openIds = collectLeafIds(root)
  // Computed once per render and reused by both the add-form's option list
  // and its empty-state check below, rather than each re-filtering `projects`
  // independently.
  const startableAddProjects = startableProjects(projects)
  // `addProjectId` only holds a value once the user has explicitly picked
  // one (or it's no longer a startable choice) — the default is re-derived
  // from `startableAddProjects` on every render instead of being written
  // into state by an effect, so it stays correct the moment `projects`
  // finishes loading even if the form was opened before that fetch resolved
  // (no effect needed, and nothing to re-sync).
  const selectedAddProjectId =
    addProjectId !== '' && startableAddProjects.some((p) => p.id === addProjectId)
      ? addProjectId
      : defaultStartProjectId(projects, activeProjectId)

  const listProps: ListPaneProps = {
    agents,
    sessionsLoaded: sessions !== null,
    error,
    projects,
    openIds,
    collapsedSections,
    onToggleSection: (bucket) => setCollapsedSections((s) => ({ ...s, [bucket]: !s[bucket] })),
    onTogglePane: togglePane,
  }

  function togglePane(id: string) {
    // Decided against the current `root`, not inside the `setRoot` updater:
    // `ptyPool.remove` is a real side effect (kills the pool entry, so the
    // shell can be reaped), and an updater function can run more than once
    // (React StrictMode) — reading `root` here, once, keeps that side
    // effect tied to exactly one real close, matching arch.md §6.2's
    // "explicit, colocated with the actual close call site" rule.
    if (findPathToLeaf(root, id)) ptyPool.remove(id)
    setRoot((r) => (findPathToLeaf(r, id) ? removeLeaf(r, id) : insertLeaf(r, id)))
    refetch()
  }

  function closePane(id: string) {
    ptyPool.remove(id)
    setRoot((r) => removeLeaf(r, id))
  }

  function openAddAgent() {
    setAddError(null)
    setAddPrompt('')
    // No explicit selection yet — `selectedAddProjectId` derives the
    // in-focus/first-startable default at render time, including once
    // `projects` finishes loading if it hasn't yet.
    setAddProjectId('')
    setAddOpen(true)
  }

  function closeAddAgent() {
    setAddOpen(false)
    setAddError(null)
    // Any spawn still in flight from this form is now stale — its own
    // `.then`/`.catch` checks this id before touching state, so canceling
    // (or the sidebar collapsing) can't have a late response reopen/clobber
    // whatever the form shows next. The spawn call itself isn't aborted —
    // mesa's `request()` has no AbortController plumbed through it — so the
    // agent it was starting still starts; this only stops that response
    // from corrupting UI state that's since moved on.
    addRequestId.current += 1
  }

  function submitAddAgent(e: React.FormEvent) {
    e.preventDefault()
    if (selectedAddProjectId === '') return
    setAdding(true)
    setAddError(null)
    const requestId = ++addRequestId.current
    const body = addPrompt.trim() === '' ? {} : { prompt: addPrompt.trim() }
    spawnProjectAgent(selectedAddProjectId, body).then(
      (spawned) => {
        // The newly started agent is real either way, so always insert its
        // pane — but only touch the form's own state if this is still the
        // request that owns it.
        setRoot((r) => insertLeaf(r, spawned.id))
        refetch()
        if (addRequestId.current !== requestId) return
        setAdding(false)
        setAddOpen(false)
        setAddPrompt('')
      },
      (err: unknown) => {
        if (addRequestId.current !== requestId) return
        setAdding(false)
        setAddError(err instanceof Error ? err.message : String(err))
      },
    )
  }

  // `activatorEvent` is the native pointerdown/mousedown that started this
  // drag — the one place dnd-kit hands over an absolute pointer position;
  // every later event on the same drag gives only `delta` relative to it.
  function handlePaneDragStart(event: DragStartEvent) {
    const ae = event.activatorEvent as MouseEvent
    dragOriginRef.current = { x: ae.clientX, y: ae.clientY }
  }

  // Live pointer position for this drag: the absolute position captured at
  // start plus the cumulative delta dnd-kit reports on every later event —
  // same reconstruction `handlePaneDragEnd` below does, so the preview
  // (continuous, via onDragMove) and the drop decision (once, via
  // onDragEnd) always agree on where the pointer actually is.
  function livePointer(event: DragMoveEvent): { x: number; y: number } | null {
    const origin = dragOriginRef.current
    if (!origin) return null
    return { x: origin.x + event.delta.x, y: origin.y + event.delta.y }
  }

  // Live preview only — recomputed continuously while a pane drag is in
  // progress. `over` briefly lags a fast pointer between frames; that's
  // fine for a preview, and `handlePaneDragEnd` never reads this state, so
  // a stale frame here can't produce a wrong drop.
  function handlePaneDragMove(event: DragMoveEvent) {
    const { over } = event
    const pointer = livePointer(event)
    if (!over || !pointer) {
      setDropZone(null)
      return
    }
    const edge = computeDropEdge(pointer, over.rect)
    setDropZone(edge ? { id: String(over.id), edge } : null)
  }

  function handlePaneDragCancel() {
    setDropZone(null)
    dragOriginRef.current = null
  }

  // The reorder-vs-move-vs-split decision itself is shared, pure logic
  // (`resolveDrop`, `frontend/src/lib/paneTree.ts`) — this handler just
  // reconstructs the live pointer position and hands off.
  function handlePaneDragEnd(event: DragEndEvent) {
    const { active, over } = event
    const pointer = livePointer(event)
    setDropZone(null)
    dragOriginRef.current = null
    if (!over) return
    setRoot((r) => resolveDrop(r, String(active.id), String(over.id), pointer, over.rect) ?? r)
  }

  function toggleDividerAt(path: number[], i: number) {
    setRoot((r) => toggleDivider(r, path, i))
  }

  // Divider mousedown → resize-start. `containerSize` is measured off THAT
  // divider's own split node's container — not a single sidebar-wide ref —
  // because a nested split's drag math must be relative to its own box.
  // Width for a row split (dragging moves along X), height for a column
  // split (dragging moves along Y); MIN_PANE_PX floors against this same
  // per-node size in the drag effect above, so the floor is naturally
  // scoped to just this split's own two adjacent children at any depth.
  function startDivider(
    path: number[],
    i: number,
    orientation: 'row' | 'column',
    startPos: number,
    container: HTMLDivElement,
  ) {
    const node = getNodeAtPath(root, path)
    if (node.kind !== 'split') return
    const rect = container.getBoundingClientRect()
    setPaneDrag({
      path,
      i,
      orientation,
      startPos,
      startA: node.children[i]?.ratio ?? DEFAULT_RATIO,
      startB: node.children[i + 1]?.ratio ?? DEFAULT_RATIO,
      containerSize: orientation === 'row' ? rect.width : rect.height,
    })
  }

  return (
    <aside
      className={`agent-sidebar${collapsed ? ' collapsed' : ''}${resizing ? ' resizing' : ''}${maximized ? ' maximized' : ''}`}
      style={{ '--agent-sidebar-width': `${width}px` } as CSSProperties}
    >
      {!collapsed && !maximized && (
        <div
          className="agent-sidebar-resize-handle"
          onMouseDown={(e) => {
            e.preventDefault()
            setResizing(true)
          }}
        />
      )}
      <div className="agent-sidebar-header-actions">
        <button
          type="button"
          className="sidebar-toggle agent-sidebar-toggle"
          aria-label={collapsed ? 'Expand agents sidebar' : 'Collapse agents sidebar'}
          title={collapsed ? 'Expand agents sidebar' : 'Collapse agents sidebar'}
          onClick={() => {
            setCollapsed((c) => !c)
            setMaximized(false)
            closeAddAgent()
          }}
        >
          {collapsed ? '«' : '»'}
        </button>
        {!collapsed && (
          <button
            type="button"
            className={`agent-sidebar-maximize${maximized ? ' active' : ''}`}
            aria-label={
              maximized
                ? 'Restore agents sidebar width'
                : 'Expand agents sidebar to fill the main content area'
            }
            title={
              maximized
                ? 'Restore panel width (Esc)'
                : 'Expand panel to fill the main content area'
            }
            onClick={() => setMaximized((m) => !m)}
          >
            {maximized ? 'restore' : 'maximize'}
          </button>
        )}
        {!collapsed && (
          <button
            type="button"
            className={`agent-sidebar-autotile${autoTile ? ' active' : ''}`}
            aria-label={autoTile ? 'Disable auto tile' : 'Enable auto tile'}
            title={
              autoTile
                ? 'Disable auto tile'
                : 'Auto tile: open a pane for every active or blocked agent, close it when done'
            }
            onClick={() => setAutoTile((v) => !v)}
          >
            auto tile
          </button>
        )}
        {!collapsed && (
          <button
            type="button"
            className={`agent-sidebar-add${addOpen ? ' active' : ''}`}
            aria-label={addOpen ? 'Cancel starting an agent' : 'Start a new agent'}
            title={addOpen ? 'Cancel starting an agent' : 'Start a new agent'}
            onClick={() => (addOpen ? closeAddAgent() : openAddAgent())}
          >
            + agent
          </button>
        )}
      </div>

      {/* A transient overlay above the pane tree, not a pane itself — it
          starts a session, it isn't one (unlike an attached agent or the
          permanent list pane, both members of `root`). */}
      {!collapsed && addOpen && (
        <form className="agent-sidebar-add-form" onSubmit={submitAddAgent}>
          <select
            value={selectedAddProjectId}
            onChange={(e) => setAddProjectId(e.target.value ? Number(e.target.value) : '')}
            required
          >
            <option value="" disabled>
              select project…
            </option>
            {startableAddProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={addPrompt}
            placeholder="optional first prompt — blank starts idle"
            onChange={(e) => setAddPrompt(e.target.value)}
          />
          <div className="agent-sidebar-add-form-actions">
            <button type="submit" disabled={adding || selectedAddProjectId === ''}>
              {adding ? 'starting…' : 'start agent'}
            </button>
            <button type="button" onClick={closeAddAgent}>
              cancel
            </button>
          </div>
          {addError && <span className="error">{addError}</span>}
          {/* `projects === null` is "still loading" (the initial `useFetch`
              value), not "confirmed zero" — showing this message during that
              window would claim no project is linked when one might be about
              to load. */}
          {projects !== null && startableAddProjects.length === 0 && (
            <span className="muted">
              No project has a linked folder yet — run{' '}
              <code>mesa project resolve</code> inside a repo to link one.
            </span>
          )}
        </form>
      )}

      <div className="agent-sidebar-body">
        <DndContext
          sensors={sensors}
          // dnd-kit's own default collision detection picks `over` off the
          // DRAGGED pane's translated bounding box, not the pointer — fine
          // when everything being dragged is small relative to its
          // droppables, but every pane here starts out (and often stays)
          // as wide/tall as the whole sidebar, so that box can overlap
          // several candidates at once and pick one the cursor isn't even
          // over. `pointerWithin` resolves `over` from the actual pointer
          // position instead, matching `computeDropEdge`'s own pointer-based
          // read below — both now agree on the one thing that has no
          // dragged-pane-size dependence.
          collisionDetection={pointerWithin}
          onDragStart={handlePaneDragStart}
          onDragMove={handlePaneDragMove}
          onDragEnd={handlePaneDragEnd}
          onDragCancel={handlePaneDragCancel}
        >
          <SplitNodeView
            node={root}
            path={[]}
            agents={agents}
            listProps={listProps}
            onClose={closePane}
            onDividerMouseDown={startDivider}
            onDividerToggle={toggleDividerAt}
            dropZone={dropZone}
          />
        </DndContext>
      </div>
    </aside>
  )
}
