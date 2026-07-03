import { useEffect, useRef, useState } from 'react'
import { getProjectAgents, spawnProjectAgent } from '../api'
import { AgentTerminal } from '../components/AgentTerminal'
import type { AgentSession } from '../types/AgentSession'
import { useFetch } from '../useFetch'

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

/**
 * The Agents tab: live Claude Code sessions running under this project's
 * folder (local_path), a start button for new background sessions, and an
 * embedded terminal attached to the selected one. Rendered in place inside
 * ProjectTasksPage's frame, like StoryboardListView.
 */
export function AgentsView({ projectId }: { projectId: number }) {
  const { data, error, refetch } = useFetch(
    () => getProjectAgents(projectId),
    `agents-${projectId}`,
    // Sessions start/finish/change state underneath the UI constantly.
    { pollMs: 3000 },
  )
  // The attached session's short job id. Held independently of the list so
  // the terminal survives the session leaving the live list mid-attach.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  // This component is not remounted when the route moves between projects
  // (App renders ProjectTasksPage at a stable position), so a stale selection
  // would otherwise attach project A's agent while viewing B. Reset it when
  // the project changes — during render, off the changed prop.
  const [prevProject, setPrevProject] = useState(projectId)
  if (projectId !== prevProject) {
    setPrevProject(projectId)
    setSelectedId(null)
  }
  // Latest project id for async callbacks: a spawn started on project A must
  // not select its agent if the user has since switched to B (the render-time
  // reset above already ran, so a bare setSelectedId in the resolve handler
  // would re-introduce a cross-project selection). Synced in an effect (not
  // during render — refs must not be written while rendering).
  const projectIdRef = useRef(projectId)
  useEffect(() => {
    projectIdRef.current = projectId
  }, [projectId])

  // Relative "started Xm ago" labels are derived from the clock at render
  // time, but useFetch drops byte-identical polls, so an idle list would never
  // re-render and the labels would freeze. A slow ticker re-renders them.
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 30000)
    return () => clearInterval(t)
  }, [])

  function start(e: React.FormEvent) {
    e.preventDefault()
    setStarting(true)
    setStartError(null)
    const body = prompt.trim() === '' ? {} : { prompt: prompt.trim() }
    spawnProjectAgent(projectId, body).then(
      (spawned) => {
        setStarting(false)
        setStartError(null)
        // Only touch this view's state if we're still on the project the spawn
        // was started for; otherwise the session belongs to a project we've
        // navigated away from.
        if (projectIdRef.current !== projectId) return
        setPrompt('')
        // Attach immediately; the list catches up on the next poll.
        setSelectedId(spawned.id)
        refetch()
      },
      (err: unknown) => {
        setStarting(false)
        setStartError(err instanceof Error ? err.message : String(err))
      },
    )
  }

  // A transient poll failure (the endpoint shells out to `claude` every 3s)
  // must NOT tear this view down: useFetch keeps the last good `data`, and an
  // attached terminal below is independent of the list fetch. So only hard-
  // fail before the first successful load; afterwards show a non-fatal banner
  // and keep rendering (list + terminal stay mounted).
  if (error && !data) return <p className="error">{error}</p>
  if (!data) return <p className="muted">Loading…</p>

  const agents = [...data.agents].sort((a, b) => b.startedAt - a.startedAt)
  const selected = agents.find((a) => a.id !== null && a.id === selectedId)

  // The embedded terminal is independent of the list fetch and the folder
  // link — its WebSocket/`claude attach` child stays alive on its own. So it
  // is rendered in every branch below (including path === null), so unlinking
  // the folder or a poll error never tears down a live attach.
  const terminalPanel = selectedId !== null && (
    <div className="agent-terminal-panel">
      <div className="agent-terminal-header">
        <span>
          attached · {selected ? agentLabel(selected) : selectedId} ({selectedId}
          )
        </span>
        <button onClick={() => setSelectedId(null)}>detach</button>
      </div>
      {/* key remounts terminal + socket when switching agents */}
      <AgentTerminal key={selectedId} agentId={selectedId} />
    </div>
  )

  if (data.path === null) {
    return (
      <>
        <p className="muted">
          This project has no linked folder, so mesa cannot see its agents. Run{' '}
          <code>mesa project resolve</code> inside the repo, or{' '}
          <code>mesa project update {projectId} --path &lt;dir&gt;</code>, to
          link one.
        </p>
        {terminalPanel}
      </>
    )
  }

  return (
    <>
      <form className="create-form" onSubmit={start}>
        <input
          type="text"
          value={prompt}
          placeholder="optional first prompt — blank starts an idle session"
          onChange={(e) => setPrompt(e.target.value)}
        />
        <button type="submit" disabled={starting}>
          {starting ? 'starting…' : 'start agent'}
        </button>
        {startError && <span className="error">{startError}</span>}
      </form>
      <p className="muted agents-path">sessions under {data.path}</p>
      {/* Non-fatal: the last good list is still shown above/below. */}
      {error && <p className="error agents-poll-error">{error}</p>}

      {agents.length === 0 ? (
        <p className="muted">No agents running in this project&apos;s folder.</p>
      ) : (
        <ul className="card-list agent-list">
          {agents.map((a) => (
            <li
              key={a.sessionId}
              className={
                (a.id !== null ? 'attachable' : '') +
                (a.id !== null && a.id === selectedId ? ' selected' : '')
              }
              onClick={() => {
                if (a.id !== null) setSelectedId(a.id)
              }}
            >
              <span className="agent-name">{agentLabel(a)}</span>
              <span className={`badge agent-kind-${a.kind}`}>{a.kind}</span>
              {a.status && (
                <span className={`badge agent-status-${a.status}`}>
                  {a.status}
                </span>
              )}
              {a.state && a.state !== a.status && (
                <span className={`badge agent-state-${a.state}`}>{a.state}</span>
              )}
              {a.waitingFor && <span className="badge blocked">{a.waitingFor}</span>}
              <div className="muted agent-meta">
                {a.id ?? a.sessionId.slice(0, 8)} · started{' '}
                {startedAgo(a.startedAt)} · {a.cwd}
                {a.id === null && ' · external terminal — not attachable'}
              </div>
            </li>
          ))}
        </ul>
      )}

      {terminalPanel}
    </>
  )
}
