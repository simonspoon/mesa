// Session call-tree layout: turns a `CcSessionGraph` (nodes + parent→child
// edges, from `GET /api/cc/sessions/{id}/graph`) into positioned React Flow
// nodes.
//
// React Flow ships no layout algorithm of its own, and unlike the storyboard
// canvas — whose edges may be cyclic, so `layout.ts` breaks cycles before
// ranking — a session graph is guaranteed a *tree* by the server: every node
// but the root has exactly one parent. That buys a plain tidy-tree pass
// (children stacked on the cross axis, parent centred on its children) with no
// cycle-breaking and no rank assignment.

import type { CcGraphNode } from './types/CcGraphNode'
import type { CcSessionGraph } from './types/CcSessionGraph'

/** Node box, in flow units. Kept in sync with `.cc-graph-node` in App.css —
 *  React Flow positions by top-left and needs a size before measuring. */
export const NODE_W = 210
export const NODE_H = 66
const GAP_X = 80 // between depths, along the flow axis
const GAP_Y = 14 // between siblings, on the cross axis

/** A positioned node, in the shape React Flow's `nodes` prop wants. Typed
 *  locally rather than importing `@xyflow/react` so this module stays pure and
 *  unit-testable with no canvas in scope. */
export type FlowNode = {
  id: string
  type: 'cc'
  position: { x: number; y: number }
  data: CcGraphNode
}

export type FlowEdge = {
  id: string
  source: string
  target: string
}

/** Children per node id, each list ordered by timestamp (nulls last, then by
 *  the server's own node order so the result is deterministic either way). */
export function childrenByParent(graph: CcSessionGraph): Map<string, string[]> {
  const order = new Map<string, number>()
  graph.nodes.forEach((n, i) => order.set(n.id, i))
  const ts = new Map<string, string | null>()
  for (const n of graph.nodes) ts.set(n.id, n.ts)

  const out = new Map<string, string[]>()
  for (const e of graph.edges) {
    // Defensive: an edge naming a node that isn't in `nodes` would otherwise
    // create a phantom child that never gets positioned.
    if (!order.has(e.from) || !order.has(e.to)) continue
    const list = out.get(e.from)
    if (list) list.push(e.to)
    else out.set(e.from, [e.to])
  }
  for (const list of out.values()) {
    list.sort((a, b) => {
      const ta = ts.get(a) ?? null
      const tb = ts.get(b) ?? null
      if (ta !== tb) {
        if (ta === null) return 1
        if (tb === null) return -1
        return ta < tb ? -1 : 1
      }
      return (order.get(a) ?? 0) - (order.get(b) ?? 0)
    })
  }
  return out
}

/** Lay the tree out left→right: x by depth, y by a tidy-tree pass that stacks
 *  leaves and centres each parent on its children.
 *
 *  Iterative, not recursive: a session's tree is usually shallow but a
 *  pathological one need not be, and a blown stack here would take the whole
 *  page down. Nodes unreachable from the root (only possible if the server's
 *  tree guarantee is ever broken) are appended below the tree rather than
 *  dropped, so a malformed payload degrades instead of vanishing. */
export function layoutSessionGraph(graph: CcSessionGraph): {
  nodes: FlowNode[]
  edges: FlowEdge[]
} {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const kids = childrenByParent(graph)
  const pos = new Map<string, { x: number; y: number }>()
  const root = graph.nodes.find((n) => n.kind === 'session')?.id ?? graph.nodes[0]?.id

  let cursorY = 0
  const visited = new Set<string>()

  if (root !== undefined) {
    // Post-order via an explicit stack: `entered` marks the second visit, when
    // every child already has a position.
    const stack: { id: string; depth: number; entered: boolean }[] = [
      { id: root, depth: 0, entered: false },
    ]
    while (stack.length > 0) {
      const frame = stack.pop()!
      const { id, depth } = frame
      if (!frame.entered) {
        // A cycle would revisit a node; the server promises a tree, but
        // guarding costs one Set lookup and turns a hang into a dropped edge.
        if (visited.has(id)) continue
        visited.add(id)
        const children = kids.get(id) ?? []
        if (children.length === 0) {
          pos.set(id, { x: depth * (NODE_W + GAP_X), y: cursorY })
          cursorY += NODE_H + GAP_Y
          continue
        }
        stack.push({ id, depth, entered: true })
        // Reversed: the stack pops last-in first, so this walks children in
        // their sorted order.
        for (let i = children.length - 1; i >= 0; i--) {
          stack.push({ id: children[i], depth: depth + 1, entered: false })
        }
        continue
      }
      // Aligned with the FIRST child, not centred between first and last.
      // A session's main thread is a time-ordered sequence that routinely runs
      // to hundreds of calls, and centring puts the root halfway down a column
      // thousands of pixels tall — visually detached from where the session
      // actually starts. First-child alignment reads as "this node, then these
      // happened under it", which is what the graph is for.
      const placed = (kids.get(id) ?? []).map((c) => pos.get(c)).filter((p) => p !== undefined)
      const y = placed.length > 0 ? placed[0]!.y : cursorY
      pos.set(id, { x: depth * (NODE_W + GAP_X), y })
    }
  }

  for (const n of graph.nodes) {
    if (pos.has(n.id)) continue
    pos.set(n.id, { x: 0, y: cursorY })
    cursorY += NODE_H + GAP_Y
  }

  const nodes: FlowNode[] = graph.nodes.map((n) => ({
    id: n.id,
    type: 'cc',
    position: pos.get(n.id)!,
    data: n,
  }))
  const edges: FlowEdge[] = graph.edges
    .filter((e) => byId.has(e.from) && byId.has(e.to))
    .map((e) => ({ id: `${e.from}->${e.to}`, source: e.from, target: e.to }))
  return { nodes, edges }
}

/** Compact token count for a node label: `231`, `44.7k`, `2.05M`. Graph nodes
 *  are ~210px wide, so a raw `15452878` would wrap the line it shares. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n < 1_000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** Drop the `claude-` prefix and any date suffix: `claude-opus-5[1m]` →
 *  `opus-5[1m]`, `claude-haiku-4-5-20251001` → `haiku-4-5`. Node width again —
 *  the family and generation are what a reader is scanning for. */
export function shortModel(model: string | null): string | null {
  if (!model) return null
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}
