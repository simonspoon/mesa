import { useLayoutEffect, useRef, useState } from 'react'
import { getCcSessionChat } from '../api'
import { useFetch } from '../useFetch'
import { Markdown } from './Markdown'
import * as ptyPool from '../lib/ptyPool'
import {
  CHAT_COMMIT_KEYS,
  CHAT_SUBMIT_KEYS,
  chatAnswerKeys,
  chatClock,
  chatGroups,
  chatNeedsReview,
  chatSendKeys,
  chatToolLabel,
  chatToolSummary,
  chatToolTarget,
  isNearBottom,
} from '../agentChat'
import type { CcChatAsk } from '../types/CcChatAsk'
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
export function AgentChat({
  agentId,
  sessionId,
  paused,
}: {
  /** The pane's own id — the background job id its terminal is attached under,
   *  which is what the composer types into (`ptyPool.send`). Not the session
   *  id: the transcript is keyed by one and the PTY by the other. */
  agentId: string
  sessionId: string
  paused: boolean
}) {
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

  // Shared by the jump-to-latest button and by sending: both are "show me the
  // tail again".
  const jumpToTail = () => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    followRef.current = true
    setAdrift(false)
  }
  // Every state below is the same two-part pane — conversation, then composer
  // at the same tree position — so half-typed text survives the first payload
  // arriving, and a session with no transcript yet (exactly the one you may
  // want to say something to) can still be spoken to.
  if (error !== null && data === null)
    return (
      <div className="agent-chat-pane">
        <div className="agent-chat agent-chat-empty">
          <p>No transcript for this session yet.</p>
          <p className="agent-chat-hint">{error}</p>
        </div>
        <Composer agentId={agentId} onSent={jumpToTail} />
      </div>
    )
  if (data === null)
    return (
      <div className="agent-chat-pane">
        <div className="agent-chat agent-chat-empty">loading…</div>
        <Composer agentId={agentId} onSent={jumpToTail} />
      </div>
    )

  const groups = chatGroups(data.turns)
  return (
    <div className="agent-chat-pane">
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
        {/* Last in the column because that is where it is in the
            conversation: the question is the newest thing the session said,
            and it is the only thing here a reader can act on. Keyed by the
            call, so the next question starts with a clean card. */}
        {data.pending_question !== null && (
          <QuestionCard
            key={data.pending_question.id}
            ask={data.pending_question}
            agentId={agentId}
            onAnswered={jumpToTail}
          />
        )}
        {adrift && (
          <button type="button" className="agent-chat-jump" onClick={jumpToTail}>
            ↓ latest
          </button>
        )}
      </div>
      <Composer agentId={agentId} onSent={jumpToTail} />
    </div>
  )
}

/**
 * The question a session is **waiting on** (task 866), as buttons.
 *
 * A chat pane is otherwise a read: the agent works, you watch. An
 * `AskUserQuestion` is the one turn where it has stopped and is waiting for a
 * person, and answering it meant switching to the terminal view and driving
 * the agent's own chooser by keyboard. So the chooser is rendered here — one
 * button per offered answer — and a click types the keystroke that picks it.
 *
 * Like the composer, it has no API: the only channel into a live session is
 * the PTY the pane is attached to (`ptyPool.send`), and the chooser is driven
 * exactly as a person at the terminal drives it — by the row's own number.
 *
 * **Mesa cannot see the chooser**, only the transcript, which records nothing
 * until the whole call is answered. What it knows is that a *fresh* chooser
 * opens on the call's first question and steps forward one question per
 * answer — so the card walks the same steps in the same order: the question
 * being answered is the live one, the ones before it show what was picked,
 * and the ones after wait their turn. A reader who answered in the terminal
 * instead is not stranded by this: the next poll clears the whole card.
 */
function QuestionCard({
  ask,
  agentId,
  onAnswered,
}: {
  ask: CcChatAsk
  /** The pane's own id — the PTY the answer is typed into, exactly as for the
   *  composer. */
  agentId: string
  onAnswered: () => void
}) {
  // The answers given so far, one entry per question in order — so its length
  // is also *which* question the chooser is showing. Local because it is: the
  // transcript carries none of it until the call resolves, at which point this
  // card is gone.
  const [answers, setAnswers] = useState<string[][]>([])
  // The boxes ticked so far on the multi-select question being answered. Its
  // own state, because a tick is not an answer: it is a keystroke the chooser
  // has taken, and the question is not finished until `commit`.
  const [ticked, setTicked] = useState<string[]>([])
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const type = (keys: string) => {
    if (!ptyPool.send(agentId, keys)) {
      setError('not connected — reopen the terminal view to reconnect')
      return false
    }
    setError(null)
    return true
  }

  const live = answers.length
  const question = ask.questions[live]
  const done = live === ask.questions.length
  const needsSubmit = done && !submitted && chatNeedsReview(ask.questions)

  const pick = (index: number, label: string) => {
    if (!type(chatAnswerKeys(index))) return
    if (question.multi_select) {
      // The same digit ticks and unticks, so the card follows the chooser
      // rather than accumulating: what it shows is what the chooser holds.
      setTicked((t) => (t.includes(label) ? t.filter((l) => l !== label) : [...t, label]))
      return
    }
    setAnswers((a) => [...a, [label]])
    // Answering is following: the reply to what you just picked is the thing
    // you are here for.
    onAnswered()
  }

  const commit = () => {
    if (!type(CHAT_COMMIT_KEYS)) return
    setAnswers((a) => [...a, ticked])
    setTicked([])
    onAnswered()
  }

  return (
    <div className="agent-chat-ask">
      <p className="agent-chat-ask-title">waiting for your answer</p>
      {ask.questions.map((q, qi) => (
        <div key={qi} className="agent-chat-ask-question">
          <div className="agent-chat-ask-head">
            {q.header && <span className="agent-chat-ask-chip">{q.header}</span>}
            <span className="agent-chat-ask-text">{q.question}</span>
          </div>
          {qi < live ? (
            <p className="agent-chat-ask-picked">{answers[qi].join(', ') || 'nothing'}</p>
          ) : (
            q.options.map((o, oi) => (
              <button
                key={oi}
                type="button"
                className={`agent-chat-ask-option${
                  qi === live && ticked.includes(o.label) ? ' agent-chat-ask-ticked' : ''
                }`}
                // Only the question the chooser is on can be answered: a
                // keystroke meant for a later one would land on this one.
                disabled={qi !== live || submitted}
                aria-pressed={q.multi_select ? ticked.includes(o.label) : undefined}
                onClick={() => pick(oi, o.label)}
              >
                <span className="agent-chat-ask-label">{o.label}</span>
                {o.description && <span className="agent-chat-ask-desc">{o.description}</span>}
              </button>
            ))
          )}
          {/* A checkbox question has no keystroke that both ticks and
              finishes, so finishing it is its own press. */}
          {qi === live && q.multi_select && !submitted && (
            <button type="button" className="agent-chat-ask-submit" onClick={commit}>
              done with this question
            </button>
          )}
        </div>
      ))}
      {needsSubmit && (
        <button
          type="button"
          className="agent-chat-ask-submit"
          onClick={() => {
            if (!type(CHAT_SUBMIT_KEYS)) return
            setSubmitted(true)
            onAnswered()
          }}
        >
          submit answers
        </button>
      )}
      {/* The card outlives its own answer by one poll at most, and saying
          nothing in that window reads as a click that did nothing. */}
      {done && !needsSubmit && <p className="agent-chat-ask-sent">sent</p>}
      {error && <p className="agent-chat-send-error">{error}</p>}
    </div>
  )
}

/**
 * The chat's send icon: a flat sharp-cornered dart in `currentColor`, drawn
 * rather than typed — the same vocabulary as the inbox transport glyphs (task
 * 832) and the brand mark, so it takes the button's cyan and its hover and
 * disabled states for free instead of rendering in whatever symbol font the
 * platform picks for `➤`.
 */
function SendIcon() {
  return (
    <svg
      className="agent-chat-send-icon"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <polygon points="1,1 15,8 1,15 4,8" />
    </svg>
  )
}

/**
 * The message box, pinned to the bottom of the pane (task 844).
 *
 * There is no "send a message" API: a chat view is a *render* of a transcript
 * file, and the only channel into a running session is the terminal this pane
 * is already attached to. So a composed message is typed into that PTY —
 * `ptyPool.send` on the pane's own leaf id — exactly as a person at the
 * terminal would type it, and the reply comes back through the ordinary
 * transcript poll like any other turn. That also means it fails the way the
 * terminal fails: no live socket, no send, said out loud rather than dropped.
 *
 * Enter sends and Shift+Enter opens a line, the convention of every chat box;
 * the multi-line case is what `chatSendKeys`'s bracketed paste exists for.
 */
function Composer({ agentId, onSent }: { agentId: string; onSent: () => void }) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // One line until it needs more, then up to a few — a pane in a 2x2 tile is
  // only a couple of hundred pixels tall, so a fixed multi-line box would eat
  // the conversation it sits under. Measured, not `field-sizing: content`,
  // which Safari does not have.
  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }

  const submit = () => {
    const keys = chatSendKeys(text)
    if (keys === null) return
    if (!ptyPool.send(agentId, keys)) {
      setError('not connected — reopen the terminal view to reconnect')
      return
    }
    setError(null)
    setText('')
    if (inputRef.current) {
      inputRef.current.style.height = 'auto'
      inputRef.current.focus()
    }
    // Sending is following: a reader who has scrolled up to something older
    // and then says something wants to see the answer.
    onSent()
  }

  return (
    <form
      className="agent-chat-composer"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      {error && <p className="agent-chat-send-error">{error}</p>}
      <div className="agent-chat-composer-row">
        <textarea
          ref={inputRef}
          className="agent-chat-input"
          rows={1}
          value={text}
          placeholder="message this agent…"
          aria-label="message this agent"
          onChange={(e) => {
            setText(e.target.value)
            // The failure it reports is about the socket, not about the text —
            // leaving it up over a composer that has since reconnected is the
            // one way this line can lie.
            if (error !== null) setError(null)
            grow(e.target)
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey) return
            // The Enter that commits an IME candidate is not a send: it
            // arrives as a plain `Enter` keydown with `isComposing` set, and
            // acting on it would ship half-converted text. Same guard, for the
            // same reason, as `CodeEditor`'s.
            if (e.nativeEvent.isComposing) return
            e.preventDefault()
            submit()
          }}
        />
        <button
          type="submit"
          className="agent-chat-send"
          title="send to this agent (Enter)"
          aria-label="send"
          disabled={chatSendKeys(text) === null}
        >
          <SendIcon />
        </button>
      </div>
    </form>
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
