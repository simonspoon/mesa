import { useCallback, useMemo, useState } from 'react'
import { getCcSessionGraph } from '../api'
import { CcNodeTextModal } from '../components/CcNodeTextModal'
import { PROMPT_COLOR, RESPONSE_COLOR, formatTokens, shortModel, toolColor } from '../sessionGraph'
import { filterRows, nodeTextTarget, threadOptions, timelineRows } from '../sessionTimeline'
import type { TimelineRow } from '../sessionTimeline'
import type { CcGraphNode } from '../types/CcGraphNode'
import type { CcGraphNodeKind } from '../types/CcGraphNodeKind'
import { useLiveContext } from '../liveContext'
import { useFetch } from '../useFetch'

// One session as a chronological, thread-grouped list (`#/cc/sessions/:id/timeline`,
// and the older `/graph` URL, which still lands here). Reached from the
// `Timeline →` link on that session's detail page.
//
// A list, not a canvas: a session's "tree" is almost always one straight column
// of main-thread calls, so the graph paid pan/zoom/minimap cost to encode
// structure that was nearly always trivial. What a reader wants — what happened,
// in order, what it acted on, where the tokens went — is a list, and a list is
// also scannable, searchable and phone-usable. The only genuinely tree-shaped
// content is a subagent run, and that reads fine as indentation under its
// thread's header row.

/** The kind toggles, in the order they read as a sentence about a session.
 *  Prompts lead: they are the causes, and everything after them is an effect. */
const KIND_FILTERS: { kind: CcGraphNodeKind; label: string }[] = [
  { kind: 'prompt', label: 'Prompts' },
  { kind: 'response', label: 'Responses' },
  { kind: 'tool', label: 'Tool calls' },
  { kind: 'skill', label: 'Skills' },
  { kind: 'agent', label: 'Subagents' },
]
const ALL_KINDS = KIND_FILTERS.map((k) => k.kind)

// Rows are cheap — plain DOM, no canvas — so the timeline asks for the server's
// own clamp rather than the graph's much smaller default.
const ROW_LIMIT = 5000

/** `<select>` sentinels. Agent node ids are always `agent:<id>`, so neither can
 *  collide with a real thread. */
const ALL_THREADS = ''
const MAIN_THREAD = 'main'

export function CCSessionTimelineView({ sessionId }: { sessionId: string }) {
  const { data, error } = useFetch(
    () => getCcSessionGraph(sessionId, ROW_LIMIT),
    `cc-timeline:${sessionId}`,
  )

  // What the person is looking at (mesa task 888) — the same session the detail
  // page reports, one drill-down deeper, which is what `detail` says. Which row
  // is open is deliberately not reported: a transcript node is the *agent's*
  // own text, not a thing on screen to be asked about by name.
  useLiveContext({
    kind: 'dashboard',
    id: sessionId,
    label: data?.project
      ? `${data.project} session ${sessionId.split('-')[0]}`
      : `session ${sessionId.split('-')[0]}`,
    detail: 'timeline',
  })

  const [query, setQuery] = useState('')
  const [kinds, setKinds] = useState<CcGraphNodeKind[]>(ALL_KINDS)
  const [thread, setThread] = useState<string>(ALL_THREADS)
  // The row whose full text is open, if any. Holding the node itself (not just
  // its id) is what lets the modal show the metadata and the stored preview
  // without a second read of the graph.
  const [openNode, setOpenNode] = useState<CcGraphNode | null>(null)
  const closeNode = useCallback(() => setOpenNode(null), [])

  const rows = useMemo(() => (data ? timelineRows(data) : []), [data])
  const threads = useMemo(() => (data ? threadOptions(data) : []), [data])
  const shown = useMemo(
    () =>
      filterRows(rows, {
        query,
        kinds: new Set(kinds),
        // Spread rather than a `threadId: …` key, because `undefined` and
        // `null` mean different things to `filterRows`: absent is "every
        // thread", `null` is "the main thread only".
        ...(thread === ALL_THREADS ? {} : { threadId: thread === MAIN_THREAD ? null : thread }),
      }),
    [rows, query, kinds, thread],
  )

  return (
    <div className="cc-timeline-page">
      <header className="cc-graph-head">
        {/* Back one step, to this session's detail page — the drill-down this
            timeline is reached from — not all the way out to the sessions
            table. */}
        <a className="cc-graph-back" href={`#/cc/sessions/${encodeURIComponent(sessionId)}`}>
          ← Session
        </a>
        <h1>Session {sessionId.split('-')[0]}</h1>
        {data && (
          <div className="cc-graph-meta">
            {data.project && <span className="cc-badge">{data.project}</span>}
            {data.git_branch && <span className="cc-graph-branch">{data.git_branch}</span>}
            {data.start && <span>{data.start.replace('T', ' ').slice(0, 16)}</span>}
            <span>
              <em>{formatTokens(data.total_tokens)}</em> tokens
            </span>
            <span>
              <em>${data.est_cost_usd.toFixed(2)}</em> est.
            </span>
          </div>
        )}
      </header>

      {/* Three populations, three budgets, three counts: `truncated` is "any
          of them was cut", so each sentence is shown only when its own counter
          fired — otherwise a response-only truncation would report "0 omitted"
          tool calls. No count is folded into another. */}
      {data?.truncated && (
        <p className="cc-graph-note">
          {data.omitted_prompts > 0 && (
            <>
              Showing the first {data.nodes.filter((n) => n.kind === 'prompt').length} prompts —{' '}
              {data.omitted_prompts.toLocaleString()} omitted.{' '}
            </>
          )}
          {data.omitted_tool_calls > 0 && (
            <>
              Showing the first {data.nodes.filter((n) => n.kind === 'tool').length} tool calls —{' '}
              {data.omitted_tool_calls.toLocaleString()} omitted. Every subagent is shown.
            </>
          )}
          {data.omitted_responses > 0 && (
            <>
              {data.omitted_tool_calls > 0 ? ' ' : ''}
              Showing the first {data.nodes.filter((n) => n.kind === 'response').length} responses —{' '}
              {data.omitted_responses.toLocaleString()} omitted.
            </>
          )}
        </p>
      )}

      {error ? (
        <p className="error">{error}</p>
      ) : !data ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted">This session recorded no prompts, tool calls or subagent runs.</p>
      ) : (
        <>
          <div className="cc-tl-filters">
            <input
              type="search"
              className="cc-tl-search"
              placeholder="Filter…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Filter rows"
            />
            <div className="cc-tl-kinds">
              {KIND_FILTERS.map((k) => (
                <label key={k.kind} className="cc-tl-kind">
                  <input
                    type="checkbox"
                    checked={kinds.includes(k.kind)}
                    onChange={(e) =>
                      setKinds((prev) =>
                        e.target.checked
                          ? [...prev, k.kind]
                          : prev.filter((existing) => existing !== k.kind),
                      )
                    }
                  />
                  {k.label}
                </label>
              ))}
            </div>
            {threads.length > 1 && (
              <select
                className="cc-tl-thread"
                value={thread}
                onChange={(e) => setThread(e.target.value)}
                aria-label="Thread"
              >
                <option value={ALL_THREADS}>All threads</option>
                {threads.map((t) => (
                  // Untrusted: an agent's label comes from its name / skill /
                  // spawn description. A text child of <option>, nothing more.
                  <option key={t.id ?? MAIN_THREAD} value={t.id ?? MAIN_THREAD}>
                    {t.label} · {t.calls} calls · {formatTokens(t.tokens)}
                  </option>
                ))}
              </select>
            )}
          </div>

          {shown.length === 0 ? (
            <p className="muted">No rows match this filter.</p>
          ) : (
            <div className="cc-tl-rows">
              {shown.map((r) => (
                <Row key={r.node.id} row={r} onOpen={setOpenNode} />
              ))}
            </div>
          )}
        </>
      )}

      {/* Mounted only once a row is opened, which is what makes the full-text
          read lazy — a few hundred rows cost nothing until one is asked for. */}
      {openNode && (
        <CcNodeTextModal sessionId={sessionId} node={openNode} onClose={closeNode} />
      )}
    </div>
  )
}

function Row({ row, onOpen }: { row: TimelineRow; onOpen: (n: CcGraphNode) => void }) {
  const n = row.node
  // Tool colours key on the tool *name* only (never the target) and the set of
  // names is open-ended, so the tint can only come from JS; the other kinds
  // have fixed colours in App.css.
  const tint =
    n.kind === 'tool'
      ? toolColor(n.name)
      : n.kind === 'response'
        ? RESPONSE_COLOR
        : n.kind === 'prompt'
          ? PROMPT_COLOR
          : undefined
  const model = shortModel(n.model)
  // A human turn has no model and no usage of its own — it is billed as part of
  // the reply it provoked. The model cell empties itself (the payload's `model`
  // is null); the token cell has to be told, or it would print the `0` the
  // payload carries, which reads as a real measurement of nothing.
  const prompt = n.kind === 'prompt'
  // A tool or response row's tokens are the issuing assistant message's, shared
  // with every other row that message produced — never this row's own. Say so
  // rather than printing a number that looks additive but is not.
  const tokenTitle = n.tokens_are_rollup
    ? 'Total tokens for this thread'
    : 'Tokens of the assistant message this row came from (shared with its sibling rows)'
  // A subagent's spawn description takes the target column; no node ever has
  // both (`description` is agent-only).
  const body = n.description ?? n.target
  // Which rows have a full body to fetch is `sessionTimeline.ts`'s decision,
  // not this file's. A row with nothing to show stays exactly what it was: no
  // role, no tab stop, no handlers.
  const openable = nodeTextTarget(n) !== null
  const open = () => onOpen(n)

  return (
    <div
      className={`cc-tl-row kind-${n.kind}${openable ? ' is-openable' : ''}`}
      data-indent={row.indent}
      style={tint ? { borderLeftColor: tint } : undefined}
      role={openable ? 'button' : undefined}
      tabIndex={openable ? 0 : undefined}
      onClick={
        openable
          ? (e) => {
              // A link inside the row owns its own click, and a drag that
              // ended in a text selection is not a click — the same two
              // carve-outs the Sessions table's row handler makes.
              if ((e.target as HTMLElement).closest('a')) return
              if (window.getSelection()?.toString()) return
              open()
            }
          : undefined
      }
      onKeyDown={
        openable
          ? (e) => {
              // Keyboard-reachable and Enter-activatable, per docs/keyboard.md:
              // the spatial nav focuses whatever is in the tab order and lets
              // the browser activate it, which a plain <div> would not do.
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                open()
              }
            }
          : undefined
      }
    >
      <span className="cc-tl-clock">{n.ts ? n.ts.slice(11, 19) : ''}</span>
      {/* Untrusted: `name` is model/transcript-authored. Text child only. */}
      <span className="cc-tl-name" style={tint ? { color: tint } : undefined}>
        {n.name}
      </span>
      {/* Untrusted: a Bash command, a path, a URL, an assistant prose preview,
          or a prompt preview — verbatim model- or transcript-authored input.
          Rendered as a text child and a `title`, never as markup, a link or any
          attribute that acts on it. */}
      <span className="cc-tl-body" title={body ?? undefined}>
        {body}
      </span>
      <span className="cc-tl-model">{model}</span>
      <span className="cc-tl-tokens" title={prompt ? undefined : tokenTitle}>
        {prompt ? '' : `${n.tokens_are_rollup ? '' : '≈'}${formatTokens(n.total_tokens)}`}
      </span>
    </div>
  )
}
