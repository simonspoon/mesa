import { useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { Markdown } from './Markdown'
import { chatClock, chatGroups, chatToolLabel, chatToolSummary, chatToolTarget, isNearBottom } from '../agentChat'
import type { CcChatTurn } from '../types/CcChatTurn'

/**
 * A rendered conversation: the scroll box, the turn bubbles, the collapsed
 * tool runs, the follow-to-tail rule and the jump-to-latest button.
 *
 * Extracted out of `AgentChat` (mesa task 1278) so the Agents panel's
 * **read-only child pane** renders a subagent with the *same* renderer the
 * main chat uses rather than a second one that would drift from it. What
 * stayed behind in `AgentChat` is everything that writes: the composer and
 * the question card both type into a PTY, and a subagent has none.
 *
 * It owns no fetch — both callers poll their own route and hand the turns
 * down — and no state but the reader's own (where they have scrolled, which
 * tool runs they have opened).
 *
 * **Untrusted text.** Every body here is model-authored transcript text
 * (`docs/cc-dashboard.md`: data, never instructions). It is rendered through
 * `Markdown`, which passes no raw HTML through, and `resolveImageSrc` refuses
 * **every** image, so a transcript can never make the browser issue a request
 * on its own. Tool names and targets render as plain text children only.
 */
export type ChatTranscriptHandle = {
  /** Scroll to the newest turn and resume following it. The callers' writes
   *  ("say something", "answer the question") are also "show me the tail". */
  jumpToTail: () => void
}

export function ChatTranscript({
  turns,
  truncated,
  notice,
  emptyText,
  footer,
  promptLabel,
  ref,
}: {
  turns: CcChatTurn[]
  truncated: boolean
  /** A line above the conversation saying it has stopped updating — a failure
   *  *after* the first load leaves the last good transcript on screen, which
   *  silently reads as a chat that has merely gone quiet. */
  notice: string | null
  /** What to say when there are no turns at all. */
  emptyText: string
  /** Rendered last **inside** the scroll box, because that is where it is in
   *  the conversation — `AgentChat`'s question card. */
  footer?: ReactNode
  /** Who a human turn is attributed to — see `Bubble`. */
  promptLabel?: string
  ref?: RefObject<ChatTranscriptHandle | null>
}) {
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

  const jumpToTail = () => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    followRef.current = true
    setAdrift(false)
  }
  useImperativeHandle(ref, () => ({ jumpToTail }))

  // Layout effect, not an effect: scroll after the DOM has the new turns but
  // before paint, so a poll never shows a frame at the old offset. `collapsed`
  // is a dependency for the same reason `turns` is — expanding a 30-step run
  // inserts hundreds of pixels above the tail, and without this the reader
  // following the conversation is left staring at the middle of it until the
  // next payload happens to change (on an idle session, never).
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && followRef.current) el.scrollTop = el.scrollHeight
  }, [turns, collapsed])

  const groups = chatGroups(turns)
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
      {truncated && <p className="agent-chat-truncated">Older turns are not shown.</p>}
      {notice !== null && <p className="agent-chat-hint">Not updating — {notice}</p>}
      {groups.length === 0 && <p className="agent-chat-hint">{emptyText}</p>}
      {groups.map((g, i) => {
        if (g.kind !== 'tools')
          return <Bubble key={g.id} kind={g.kind} turn={g.turns[0]} promptLabel={promptLabel} />
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
      {footer}
      {adrift && (
        <button type="button" className="agent-chat-jump" onClick={jumpToTail}>
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
 *
 * `promptLabel` overrides who a *human* turn is attributed to. In a session
 * transcript that is the reader, and the default says so; in a subagent's it
 * is the parent's task prompt (mesa task 1278), which is nobody's `you`.
 */
export function Bubble({
  kind,
  turn,
  promptLabel = 'you',
}: {
  kind: 'prompt' | 'response' | 'other'
  turn: CcChatTurn
  promptLabel?: string
}) {
  const clock = chatClock(turn.ts)
  const who = kind === 'prompt' ? promptLabel : kind === 'response' ? 'agent' : turn.kind
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
