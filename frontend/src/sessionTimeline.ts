// Session timeline: turns a `CcSessionGraph` (nodes + parent→child edges, from
// `GET /api/cc/sessions/{id}/graph`) into a flat, chronological row list.
//
// The payload is a tree, but a real session is overwhelmingly one straight
// column of main-thread calls — the only genuinely tree-shaped content is a
// subagent run, and indentation under a thread header says that just as well as
// a canvas did. So the shape here is a *list*, in the server's own node order
// (`nodes` is root first, then oldest-first, with equal-`ts` ties already fixed
// as response-before-tool). Nothing in this module re-sorts.

import type { CcGraphNode } from './types/CcGraphNode'
import type { CcGraphNodeKind } from './types/CcGraphNodeKind'
import type { CcSessionGraph } from './types/CcSessionGraph'

/** One rendered line. `threadId` is the owning subagent's *node id*
 *  (`agent:<agent_id>`), `null` for the main thread; `indent` is 0 on the main
 *  thread and 1 inside a subagent — a nested spawn indents no further, since
 *  the thread header already names it and deeper steps buy nothing but a
 *  narrower column. */
export type TimelineRow = {
  node: CcGraphNode
  threadId: string | null
  indent: 0 | 1
}

/** Node id → the id of the nearest `agent` **ancestor** (`null` = main thread).
 *
 *  Strictly an ancestor: an agent node's own thread is the one it was spawned
 *  from, which is what puts its header row at that thread's indent with its
 *  children one level in.
 *
 *  Defensive in the same two ways `childrenByParent` was: an edge naming a node
 *  that isn't in `nodes` is ignored, and a seen-set stops a malformed cyclic
 *  payload from hanging the page. */
export function threadOf(graph: CcSessionGraph): Map<string, string | null> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const parent = new Map<string, string>()
  for (const e of graph.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue
    // First parent wins; the server promises exactly one.
    if (!parent.has(e.to)) parent.set(e.to, e.from)
  }

  const out = new Map<string, string | null>()
  for (const n of graph.nodes) {
    const seen = new Set<string>([n.id])
    let cur = parent.get(n.id)
    let thread: string | null = null
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur)
      if (byId.get(cur)?.kind === 'agent') {
        thread = cur
        break
      }
      cur = parent.get(cur)
    }
    out.set(n.id, thread)
  }
  return out
}

/** Every node but the `session` root, each tagged with its thread and indent.
 *  The root is dropped because its data is the page header.
 *
 *  Tool and response rows come out in **payload order, never re-sorted** — the
 *  server already emits them oldest-first with equal-`ts` ties fixed as
 *  response-before-tool, and re-deriving that here could only get it wrong.
 *
 *  An `agent` node is the one exception, and it is placement rather than
 *  sorting: the server appends every agent node *after* the whole tool/response
 *  block, so at its literal payload position a subagent's header row lands at
 *  the bottom of the page, hundreds of rows below the run it names. Each header
 *  is therefore emitted immediately before the first row of its own thread (its
 *  own ancestors' headers first, for a nested spawn), which is what "indented
 *  under its header" means at all. An agent whose thread contributed no rows —
 *  every one of them truncated away — still appears, at the end, so no run
 *  silently vanishes. */
export function timelineRows(graph: CcSessionGraph): TimelineRow[] {
  const threads = threadOf(graph)
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const rows: TimelineRow[] = []
  const emitted = new Set<string>()

  const row = (node: CcGraphNode): TimelineRow => {
    const threadId = threads.get(node.id) ?? null
    return { node, threadId, indent: threadId === null ? 0 : 1 }
  }

  /** Emit the header chain for `threadId`, outermost first. Iterative and
   *  seen-guarded: `threadOf` already tolerates a cyclic payload, and this must
   *  not reintroduce a way to hang on one. */
  const emitHeaders = (threadId: string | null) => {
    const chain: CcGraphNode[] = []
    let cur = threadId
    const seen = new Set<string>()
    while (cur !== null && !emitted.has(cur) && !seen.has(cur)) {
      seen.add(cur)
      const agent = byId.get(cur)
      if (agent === undefined) break
      chain.push(agent)
      cur = threads.get(cur) ?? null
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      emitted.add(chain[i].id)
      rows.push(row(chain[i]))
    }
  }

  for (const node of graph.nodes) {
    if (node.kind === 'session') continue
    // Agent nodes arrive only as headers, from `emitHeaders`.
    if (node.kind === 'agent') continue
    emitHeaders(threads.get(node.id) ?? null)
    rows.push(row(node))
  }
  // Threads that contributed no row of their own still get their header.
  for (const node of graph.nodes) {
    if (node.kind === 'agent' && !emitted.has(node.id)) emitHeaders(node.id)
  }
  return rows
}

export type TimelineFilter = {
  /** Case-insensitive substring over `name` + `target`. Blank = everything. */
  query?: string
  /** Allow-set of kinds. Empty or absent = every kind. */
  kinds?: ReadonlySet<CcGraphNodeKind>
  /** Thread node id, or `null` for the main thread. **Absent** (`undefined`)
   *  means no thread filter at all — `null` is a real selection, not "off". */
  threadId?: string | null
}

export function filterRows(
  rows: readonly TimelineRow[],
  filter: TimelineFilter = {},
): TimelineRow[] {
  const q = (filter.query ?? '').trim().toLowerCase()
  const kinds = filter.kinds && filter.kinds.size > 0 ? filter.kinds : null
  const threadSelected = 'threadId' in filter
  return rows.filter((r) => {
    if (threadSelected) {
      // The selected thread's own agent node is its header row, so it survives
      // the thread filter even though it belongs to the thread that spawned it.
      const own = r.threadId === filter.threadId || r.node.id === filter.threadId
      if (!own) return false
    }
    if (kinds && !kinds.has(r.node.kind)) return false
    if (q) {
      const hay = `${r.node.name}\n${r.node.target ?? ''}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
}

export type ThreadOption = {
  /** Node id of the subagent, or `null` for the main thread. */
  id: string | null
  label: string
  /** Tool calls **as shown** — counted off the payload, so a truncated graph
   *  reports what the list actually holds rather than the server's full count. */
  calls: number
  /** The thread's own rolled-up usage, straight off its `session`/`agent` node.
   *  Never a sum of the rows: tool/response tokens repeat one message's usage. */
  tokens: number
}

/** One entry per thread for the selector: main thread first, then subagents in
 *  first-appearance order. A label is never blank — an agent with no usable
 *  name/skill/description falls back to a constant. */
export function threadOptions(graph: CcSessionGraph): ThreadOption[] {
  const threads = threadOf(graph)
  const calls = new Map<string | null, number>()
  for (const n of graph.nodes) {
    if (n.kind !== 'tool') continue
    const t = threads.get(n.id) ?? null
    calls.set(t, (calls.get(t) ?? 0) + 1)
  }

  const root = graph.nodes.find((n) => n.kind === 'session')
  const out: ThreadOption[] = [
    {
      id: null,
      label: 'Main thread',
      calls: calls.get(null) ?? 0,
      tokens: root?.total_tokens ?? graph.total_tokens,
    },
  ]
  for (const n of graph.nodes) {
    if (n.kind !== 'agent') continue
    out.push({
      id: n.id,
      label: firstNonBlank(n.name, n.skill, n.description) ?? 'Subagent',
      calls: calls.get(n.id) ?? 0,
      tokens: n.total_tokens,
    })
  }
  return out
}

function firstNonBlank(...vals: (string | null)[]): string | null {
  for (const v of vals) {
    if (v && v.trim() !== '') return v.trim()
  }
  return null
}
