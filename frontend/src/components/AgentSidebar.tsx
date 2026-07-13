import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { listAllAgents, listProjects } from '../api'
import { projectForCwd } from '../agentProject'
import type { AgentSession } from '../types/AgentSession'
import { useFetch } from '../useFetch'
import { AgentTerminal } from './AgentTerminal'

const MIN_WIDTH = 280
const MAX_WIDTH = 720
const DEFAULT_WIDTH = 448 // 28rem, matches the CSS fallback

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
 * Global, persistent right-hand sidebar: every live Claude Code session
 * across every project, with an embedded terminal for the selected one.
 * Rendered once in `App.tsx`, outside the router — it never unmounts on
 * navigation, so collapsing it only changes CSS (width), never the React
 * tree. That is load-bearing: an attached terminal's WebSocket lives on the
 * `AgentTerminal` instance below, and it must survive a collapse/expand
 * cycle with no reconnect, exactly like leaving the tab and coming back.
 */
export function AgentSidebar() {
  const [collapsed, setCollapsed] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // DONE starts collapsed (stale sessions aren't the thing you want to see
  // first); BLOCKED/ACTIVE start open since those need attention.
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
      setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next)))
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
  const selected = agents.find((a) => a.id !== null && a.id === selectedId)

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
                              (a.id !== null && a.id === selectedId ? ' selected' : '')
                            }
                            onClick={() => {
                              if (a.id !== null) {
                                setSelectedId(a.id)
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

        {selectedId !== null && (
          <div className="agent-sidebar-panel">
            <div className="agent-terminal-header">
              <span>
                attached · {selected ? agentLabel(selected) : selectedId} ({selectedId})
              </span>
              <button onClick={() => setSelectedId(null)}>close</button>
            </div>
            {/* key remounts terminal + socket when switching agents */}
            <AgentTerminal key={selectedId} agentId={selectedId} />
          </div>
        )}
      </div>
    </aside>
  )
}
