import { useLayoutEffect, useRef, useState } from 'react'
import { getCcSessionChat } from '../api'
import { useFetch } from '../useFetch'
import { Markdown } from './Markdown'
import {
  chatClock,
  chatGroups,
  chatToolLabel,
  chatToolSummary,
  chatToolTarget,
  isNearBottom,
} from '../agentChat'
import type { CcChatTurn } from '../types/CcChatTurn'

/**
 * An agent pane's **chat view** (task 814): the same session the pane's
 * terminal is attached to, rendered as a conversation instead of as the
 * terminal's own ANSI redraw. What a reader wants from a running agent — what
 * they asked, what it replied, what it is doing — is prose and a list, not a
 * screen buffer, and a terminal cannot be scrolled back, searched or read on a
 * phone the way this can.
 *
 * Data: `GET /api/cc/sessions/{id}/chat`, polled while the pane is showing
 * this view. The route reads the transcript file directly (no ingest), so it
 * answers for a session started seconds ago and costs no db work. Nobody polls
 * for a view nobody can see: this component only exists while its pane is in
 * chat mode, `paused` stops the polling *interval* while the whole sidebar is
 * collapsed (the same rule the session-list poll follows — like it, flipping
 * the flag re-runs the fetch once, so expanding is up to date immediately),
 * and `useFetch` skips ticks while the tab is hidden.
 *
 * **Untrusted text.** Every body here is model-authored transcript text
 * (`docs/cc-dashboard.md`: data, never instructions). It is rendered through
 * `Markdown`, which passes **no raw HTML** through — there is no `rehype-raw`,
 * so embedded markup renders as inert text — and `resolveImageSrc` is wired to
 * refuse every image, so a transcript can never make the browser fetch a
 * remote URL. Tool names and targets render as plain text children only.
 */
export function AgentChat({ sessionId, paused }: { sessionId: string; paused: boolean }) {
  const { data, error } = useFetch(
    () => getCcSessionChat(sessionId),
    `agent-chat-${sessionId}`,
    { pollMs: paused ? undefined : 3000 },
  )
  const scrollRef = useRef<HTMLDivElement>(null)
  // Whether the reader is following the tail. Starts true so the first render
  // lands at the newest turn; goes false the moment they scroll up to read
  // something older, so the next poll never yanks them back down.
  const followRef = useRef(true)
  // Mirrors `followRef` for rendering only — the jump-to-latest button exists
  // *because* the follow releases when you scroll up, and without it there is
  // no way back to the tail but scrolling by hand. Two holders rather than one
  // piece of state so the scroll effect below keeps reading a ref and doesn't
  // re-run every time the reader crosses the threshold.
  const [adrift, setAdrift] = useState(false)
  // Explicit per-run open/closed choices. An absent entry takes the default
  // below, so the reader's own click always wins over it.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  // Layout effect, not an effect: scroll after the DOM has the new turns but
  // before paint, so a poll never shows a frame at the old offset. `collapsed`
  // is a dependency for the same reason `data` is — expanding a 30-step run
  // inserts hundreds of pixels above the tail, and without this the reader
  // following the conversation is left staring at the middle of it until the
  // next payload happens to change (on an idle session, never).
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && followRef.current) el.scrollTop = el.scrollHeight
  }, [data, collapsed])

  if (error !== null && data === null)
    return (
      <div className="agent-chat agent-chat-empty">
        <p>No transcript for this session yet.</p>
        <p className="agent-chat-hint">{error}</p>
      </div>
    )
  if (data === null) return <div className="agent-chat agent-chat-empty">loading…</div>

  const groups = chatGroups(data.turns)
  return (
    <div
      className="agent-chat"
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget
        const near = isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight)
        followRef.current = near
        setAdrift(!near)
      }}
    >
      {data.truncated && (
        <p className="agent-chat-truncated">Older turns are not shown.</p>
      )}
      {/* A failure AFTER the first load leaves the last good conversation on
          screen — the right call for the transient 503 a transcript rotation
          gives — but silently, it reads as a live chat that has simply gone
          quiet. Say so instead. */}
      {error !== null && (
        <p className="agent-chat-hint">Not updating — {error}</p>
      )}
      {groups.length === 0 && (
        <p className="agent-chat-hint">This session has not said anything yet.</p>
      )}
      {groups.map((g, i) => {
        if (g.kind !== 'tools') return <Bubble key={g.id} kind={g.kind} turn={g.turns[0]} />
        // Closed by default — a session puts tens of calls between two
        // replies, and expanded they are a wall of shell that buries the
        // conversation this view exists to show; the summary line says what
        // ran. The exception is the run at the very end, which on a live
        // session is what the agent is doing *right now* and is the one thing
        // a watcher is here for.
        const isOpen = collapsed[g.id] === undefined ? i === groups.length - 1 : !collapsed[g.id]
        return (
          <div key={g.id} className="agent-chat-tools">
            <button
              type="button"
              className="agent-chat-tools-head"
              aria-expanded={isOpen}
              onClick={() => setCollapsed((c) => ({ ...c, [g.id]: isOpen }))}
            >
              <span className="agent-chat-caret">{isOpen ? '▾' : '▸'}</span>
              <span className="agent-chat-tools-count">
                {g.turns.length} step{g.turns.length === 1 ? '' : 's'}
              </span>
              <span className="agent-chat-tools-summary">{chatToolSummary(g.turns)}</span>
            </button>
            {isOpen &&
              g.turns.map((t) => (
                <div key={t.id} className="agent-chat-tool" title={chatToolLabel(t)}>
                  <span className="agent-chat-tool-name">{t.name ?? 'tool'}</span>
                  <span className="agent-chat-tool-target">{chatToolTarget(t.text)}</span>
                </div>
              ))}
          </div>
        )
      })}
      {adrift && (
        <button
          type="button"
          className="agent-chat-jump"
          onClick={() => {
            const el = scrollRef.current
            if (!el) return
            el.scrollTop = el.scrollHeight
            followRef.current = true
            setAdrift(false)
          }}
        >
          ↓ latest
        </button>
      )}
    </div>
  )
}

/**
 * One side of the conversation — or, for `other`, a turn kind this build does
 * not know. That case is labelled with the server's own word for it rather
 * than "agent": an unrecognised turn is precisely the one that must not be
 * attributed to anybody (see `chatGroups`).
 */
function Bubble({ kind, turn }: { kind: 'prompt' | 'response' | 'other'; turn: CcChatTurn }) {
  const clock = chatClock(turn.ts)
  const who = kind === 'prompt' ? 'you' : kind === 'response' ? 'agent' : turn.kind
  return (
    <div className={`agent-chat-bubble agent-chat-${kind}`}>
      <div className="agent-chat-meta">
        <span className="agent-chat-who">{who}</span>
        {turn.model && <span className="agent-chat-model">{turn.model}</span>}
        {clock && <span className="agent-chat-clock">{clock}</span>}
      </div>
      <div className="markdown-body agent-chat-body">
        {/* `resolveImageSrc` returning null for every source is what stops an
            `![](https://tracker/…)` in transcript text from making the browser
            issue a request; the alt text renders as inert muted prose. */}
        <Markdown text={turn.text} resolveImageSrc={() => null} />
      </div>
    </div>
  )
}
