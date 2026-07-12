import { useEffect, useState } from 'react'
import { listAllAgents, listProjects } from '../api'
import type { AgentSession } from '../types/AgentSession'
import type { Project } from '../types/Project'
import { useFetch } from '../useFetch'
import { AgentTerminal } from './AgentTerminal'

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

/** The project whose `local_path` is `cwd` or a parent of it — the same
 * prefix relationship `claude agents --cwd` itself matches on. Ties (nested
 * project folders) favor the longest/most-specific `local_path`. */
function projectForCwd(cwd: string, projects: Project[]): Project | undefined {
  return projects
    .filter(
      (p) =>
        p.local_path !== null &&
        (cwd === p.local_path || cwd.startsWith(p.local_path + '/')),
    )
    .sort((a, b) => b.local_path!.length - a.local_path!.length)[0]
}

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
    <aside className={`agent-sidebar${collapsed ? ' collapsed' : ''}`}>
      <button
        type="button"
        className="sidebar-toggle agent-sidebar-toggle"
        aria-label={collapsed ? 'Expand agents sidebar' : 'Collapse agents sidebar'}
        title={collapsed ? 'Expand agents sidebar' : 'Collapse agents sidebar'}
        onClick={() => setCollapsed((c) => !c)}
      >
        {collapsed ? '«' : '»'}
      </button>

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
            <ul className="card-list agent-list">
              {agents.map((a) => {
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
