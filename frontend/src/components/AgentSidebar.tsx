import { Fragment, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { listAllAgents, listProjects } from '../api'
import { projectForCwd } from '../agentProject'
import type { AgentSession } from '../types/AgentSession'
import { useFetch } from '../useFetch'
import { AgentTerminal } from './AgentTerminal'

const MIN_WIDTH = 280
const DEFAULT_WIDTH = 448 // 28rem, matches the CSS fallback
// No fixed upper cap (unlike the old 720px ceiling) — but `main` still needs
// a floor, or dragging past it squeezes its content (the CC Dashboard's
// cards, etc.) into character-by-character wrapping rather than a clean
// overflow the browser would otherwise catch. Measured live off `main`'s own
// rect each move, not a hardcoded viewport fraction, so it tracks the left
// nav sidebar's actual width (collapsed or expanded) instead of assuming one.
const MIN_MAIN_WIDTH = 320

const MIN_PANE_PX = 80 // floor on a pane's own height during divider drag
const DEFAULT_RATIO = 1

function agentLabel(a: AgentSession): string {
  return a.name ?? a.id ?? a.sessionId.slice(0, 8)
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
 * One open agent's pane inside the split view: a header (drag handle + label
 * + close) over its own independent `AgentTerminal`. `ratio` is this pane's
 * share of the stack's flex space (see `AgentSidebar`'s divider-drag comment)
 * — sortable via dnd-kit, so panes are also rearrangeable by dragging the
 * header's grip.
 */
function Pane({
  agentId,
  label,
  ratio,
  onClose,
}: {
  agentId: string
  label: string
  ratio: number
  onClose: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: agentId,
  })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    flexGrow: ratio,
    flexBasis: 0,
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
        </span>
        <button onClick={onClose}>close</button>
      </div>
      {/* key remounts terminal + socket only if agentId itself changes */}
      <AgentTerminal key={agentId} agentId={agentId} />
    </div>
  )
}

/**
 * Global, persistent right-hand sidebar: every live Claude Code session
 * across every project, with room to attach one pane per selected session.
 * Rendered once in `App.tsx`, outside the router — it never unmounts on
 * navigation, so collapsing it only changes CSS (width), never the React
 * tree. That is load-bearing: each open pane's `AgentTerminal` owns a
 * WebSocket, and it must survive a collapse/expand cycle with no reconnect,
 * exactly like leaving the tab and coming back — now true for every open
 * pane, not just one.
 */
export function AgentSidebar() {
  const [collapsed, setCollapsed] = useState(true)
  // Order = pane order, top to bottom. A session toggles in/out of this list
  // by clicking it in the session list below; dragging a pane's grip
  // reorders it (dnd-kit sortable).
  const [openIds, setOpenIds] = useState<string[]>([])
  // Each open pane's share of the stack's flex space (flex-grow). Missing
  // entries default to DEFAULT_RATIO — opening a new pane needs no
  // renormalization since flexbox distributes by ratio automatically.
  const [ratios, setRatios] = useState<Record<string, number>>({})
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

  const panesRef = useRef<HTMLDivElement>(null)
  // Set while dragging a divider between two adjacent panes; `i` is the
  // index of the upper pane (the divider sits between openIds[i] and
  // openIds[i+1]). Captured once at mousedown so the drag reads as a delta
  // from a stable baseline rather than accumulating rounding error.
  const [paneDrag, setPaneDrag] = useState<null | {
    i: number
    startY: number
    startA: number
    startB: number
    containerH: number
  }>(null)

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
  // two adjacent panes' combined ratio, so the same drag distance feels
  // consistent regardless of how many panes are open or their current split.
  useEffect(() => {
    if (!paneDrag) return
    const onMove = (e: MouseEvent) => {
      const idA = openIds[paneDrag.i]
      const idB = openIds[paneDrag.i + 1]
      if (!idA || !idB || paneDrag.containerH <= 0) return
      const sum = paneDrag.startA + paneDrag.startB
      const deltaRatio = ((e.clientY - paneDrag.startY) / paneDrag.containerH) * sum
      const minRatio = (MIN_PANE_PX / paneDrag.containerH) * sum
      const nextA = Math.min(sum - minRatio, Math.max(minRatio, paneDrag.startA + deltaRatio))
      setRatios((r) => ({ ...r, [idA]: nextA, [idB]: sum - nextA }))
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
    // openIds intentionally omitted: paneDrag.i indexes the order as it was
    // at drag start, and a reorder mid-drag is not a case worth handling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Relative "started Xm ago" labels are derived from the clock at render
  // time, but useFetch drops byte-identical polls, so an idle list would
  // never re-render and the labels would freeze (mirrors AgentsView).
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 30000)
    return () => clearInterval(t)
  }, [])

  const agents = [...(sessions ?? [])].sort((a, b) => b.startedAt - a.startedAt)

  function togglePane(id: string) {
    setOpenIds((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
    )
  }

  function closePane(id: string) {
    setOpenIds((ids) => ids.filter((x) => x !== id))
    setRatios((r) => {
      if (!(id in r)) return r
      const next = { ...r }
      delete next[id]
      return next
    })
  }

  function handlePaneDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setOpenIds((ids) => {
      const from = ids.indexOf(String(active.id))
      const to = ids.indexOf(String(over.id))
      if (from === -1 || to === -1) return ids
      return arrayMove(ids, from, to)
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
      </div>

      <div className="agent-sidebar-body">
        <div className="agent-sidebar-list">
          <h2 className="agent-sidebar-head">
            Agents
            {agents.length > 0 && <span className="agent-sidebar-count">{agents.length}</span>}
          </h2>
          {error && !sessions ? (
            <p className="error">{error}</p>
          ) : !sessions ? (
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
                    onClick={() =>
                      setCollapsedSections((s) => ({ ...s, [bucket]: !s[bucket] }))
                    }
                  >
                    <span className="agent-sidebar-section-caret">
                      {sectionCollapsed ? '▸' : '▾'}
                    </span>
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
                              if (a.id !== null) {
                                togglePane(a.id)
                                refetch()
                              }
                            }}
                          >
                            <span className="agent-name">{agentLabel(a)}</span>
                            <span className={`badge agent-kind-${a.kind}`}>{a.kind}</span>
                            {a.status && (
                              <span className={`badge agent-status-${a.status}`}>{a.status}</span>
                            )}
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

        {openIds.length > 0 && (
          <DndContext sensors={sensors} onDragEnd={handlePaneDragEnd}>
            <SortableContext items={openIds} strategy={verticalListSortingStrategy}>
              <div className="agent-sidebar-panes" ref={panesRef}>
                {openIds.map((id, i) => {
                  const session = agents.find((a) => a.id === id)
                  return (
                    // Pane and divider are flat siblings of every other pane
                    // — flex-grow ratios only compete against true siblings,
                    // so a wrapping element per pane would isolate each
                    // pane's growth to its own subtree instead of the stack.
                    <Fragment key={id}>
                      <Pane
                        agentId={id}
                        label={session ? agentLabel(session) : id}
                        ratio={ratios[id] ?? DEFAULT_RATIO}
                        onClose={() => closePane(id)}
                      />
                      {i < openIds.length - 1 && (
                        <div
                          className="agent-sidebar-pane-divider"
                          onMouseDown={(e) => {
                            e.preventDefault()
                            const container = panesRef.current
                            if (!container) return
                            setPaneDrag({
                              i,
                              startY: e.clientY,
                              startA: ratios[id] ?? DEFAULT_RATIO,
                              startB: ratios[openIds[i + 1]] ?? DEFAULT_RATIO,
                              containerH: container.getBoundingClientRect().height,
                            })
                          }}
                        />
                      )}
                    </Fragment>
                  )
                })}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>
    </aside>
  )
}
