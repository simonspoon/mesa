import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { getCcSubagentChat } from '../api'
import { useFetch } from '../useFetch'
import { ChatTranscript } from './ChatTranscript'
import { childElapsed, childPaneName, childPromptLabel, type ChildPaneRef } from '../agentChild'
import { formatContextTokens } from '../agentRow'
import type { AgentChild } from '../types/AgentChild'

/**
 * A child pane's body (mesa task 1278): one subagent's conversation, or one
 * shell's command line — the read-only twin of `AgentChat`.
 *
 * **Read-only by construction, not by policy.** There is no composer and no
 * question card here because there is nothing to type into: a subagent runs
 * in-process with no PTY of its own, and a shell is a Bash call already in
 * flight. The conversation itself is the shared `ChatTranscript`, the same
 * renderer the main chat uses.
 *
 * The meta line (tokens, elapsed, state) comes from the parent session's live
 * `children` on the sidebar's own poll, so it thins out for a child that has
 * dropped off the list — a subagent's transcript is still on disk and still
 * readable after that, and the pane says so by showing fewer figures rather
 * than closing itself.
 */
export function ChildPane({
  paneRef,
  child,
  parentLabel,
  sessionId,
  paused,
}: {
  paneRef: ChildPaneRef
  /** This child as the newest poll reports it, or `null` once it is no longer
   *  among its parent's children. */
  child: AgentChild | null
  /** What the parent session is called — the pane header's `of <parent>`, and
   *  who a subagent's opening prompt is attributed to. */
  parentLabel: string
  /** The parent's Claude Code session id, which a subagent's transcript is
   *  filed under. `null` when the parent has dropped out of the session list,
   *  leaving nothing to read the transcript by. */
  sessionId: string | null
  /** True while nobody can see this pane — polling stops, exactly as the
   *  session list's and the chat's do. */
  paused: boolean
}) {
  const name = childPaneName(paneRef, child)
  const tokens = formatContextTokens(child?.contextTokens)
  // The card's elapsed clock reads the wall clock where it renders, because
  // the list re-renders on its own 3s poll. A pane does not: a subagent that
  // has stopped saying anything returns a byte-identical payload, which
  // `useFetch` drops, so the clock would freeze at whatever it said when the
  // pane opened. Its own second-hand, stopped once the child has finished —
  // there is nothing left for it to count.
  const running = child === null || child.state === 'running'
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running || paused) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running, paused])
  const elapsed = childElapsed(child?.startedAt ?? null, now)
  const meta = (
    <div className="muted agent-child-pane-meta">
      {tokens && (
        <span title={`${child?.contextTokens} tokens in the context window`}>{tokens}</span>
      )}
      {elapsed && <span title={`running for ${elapsed}`}>{elapsed}</span>}
      <span>{child?.state ?? 'no longer listed'}</span>
    </div>
  )

  // A shell child, deliberately with no output (mesa task 1278). mesa has
  // none to show: a shell child is built from a `ps` probe, whose row carries
  // no `tool_use` id and whose `args` is Claude Code's own
  // `zsh -c 'source …snapshot && eval …'` wrapper rather than the command the
  // agent ran — so matching it back to a transcript call would be a guess, and
  // a wrong guess renders some other call's output under this one. Claude Code
  // does not stream a Bash call's output into the transcript while it runs
  // either, and the process leaves the table the instant the call returns, so
  // there is no later moment at which this pane could fill the gap in.
  if (paneRef.agentId === null)
    return (
      <Shell meta={meta}>
        {/* Untrusted text from outside mesa — a command line someone wrote.
            A plain text child of a `<code>`, never HTML or a URL. */}
        <pre className="agent-child-pane-command">
          <code>{child?.name ?? paneRef.name ?? name}</code>
        </pre>
        <p className="agent-chat-hint">
          A Bash call in flight. Claude Code does not stream a shell's output into the transcript,
          so mesa has none to show — only that it is still running.
        </p>
      </Shell>
    )

  if (sessionId === null)
    return (
      <Shell meta={meta} empty>
        <p>This subagent's session is no longer listed.</p>
        <p className="agent-chat-hint">
          A subagent's transcript is filed under its session, so mesa has nothing to read it by.
        </p>
      </Shell>
    )

  return (
    <SubagentTranscript
      sessionId={sessionId}
      agentId={paneRef.agentId}
      promptLabel={childPromptLabel(parentLabel, name)}
      paused={paused}
      meta={meta}
    />
  )
}

/** The pane body's two fixed parts — the live meta line above whatever the
 *  pane has to show — so every state below renders the same frame. */
function Shell({
  meta,
  empty,
  children,
}: {
  meta: ReactNode
  empty?: boolean
  children: ReactNode
}) {
  return (
    <div className="agent-chat-pane agent-child-pane">
      {meta}
      <div className={`agent-chat${empty ? ' agent-chat-empty' : ''}`}>{children}</div>
    </div>
  )
}

/**
 * The subagent half. Its own component so the poll is mounted only for a pane
 * that has something to poll: a shell pane, and one whose session has left the
 * list, must not open a fetch they would never use, and `useFetch` is a hook.
 */
function SubagentTranscript({
  sessionId,
  agentId,
  promptLabel,
  paused,
  meta,
}: {
  sessionId: string
  agentId: string
  promptLabel: string
  paused: boolean
  meta: ReactNode
}) {
  const { data, error } = useFetch(
    () => getCcSubagentChat(sessionId, agentId),
    `subagent-chat-${sessionId}-${agentId}`,
    // The chat view's own cadence, paused on its own terms: nobody polls a
    // view nobody can see.
    { pollMs: paused ? undefined : 3000 },
  )

  if (error !== null && data === null)
    return (
      <Shell meta={meta} empty>
        <p>No transcript for this subagent yet.</p>
        <p className="agent-chat-hint">{error}</p>
      </Shell>
    )
  if (data === null) return <Shell meta={meta} empty>loading…</Shell>

  return (
    <div className="agent-chat-pane agent-child-pane">
      {meta}
      <ChatTranscript
        turns={data.turns}
        truncated={data.truncated}
        notice={error}
        emptyText="This subagent has not said anything yet."
        // Its opening user turn is the task its parent handed it, not
        // something the reader typed — see `childPromptLabel`.
        promptLabel={promptLabel}
      />
    </div>
  )
}
