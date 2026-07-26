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
export const NODE_H = 80
const GAP_X = 80 // between depths, along the flow axis
const GAP_Y = 14 // between siblings, on the cross axis

/** A positioned node, in the shape React Flow's `nodes` prop wants. Typed
 *  locally rather than importing `@xyflow/react` so this module stays pure and
 *  unit-testable with no canvas in scope.
 *
 *  `width`/`height` are not optional decoration. React Flow only ever writes a
 *  node's *measured* size back into the array you passed via `onNodesChange`,
 *  and this graph is a static read-only layout with no such handler — so
 *  `node.measured` stays undefined forever. The main canvas doesn't care (it
 *  measures the real DOM), but `<MiniMap>` reads the user node and skips any
 *  whose `measured ?? width ?? initialWidth` is undefined, so without these two
 *  fields it draws its mask and zero node rects. */
export type FlowNode = {
  id: string
  type: 'cc'
  position: { x: number; y: number }
  width: number
  height: number
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
    width: NODE_W,
    height: NODE_H,
    data: n,
  }))
  const edges: FlowEdge[] = graph.edges
    .filter((e) => byId.has(e.from) && byId.has(e.to))
    .map((e) => ({ id: `${e.from}->${e.to}`, source: e.from, target: e.to }))
  return { nodes, edges }
}

/** Minimap height in CSS pixels — React Flow's `<MiniMap>` default, repeated
 *  here because the stroke below has to reason about it. */
const MINIMAP_H = 150
/** Smallest node mark worth drawing, in CSS pixels. Below ~3px a node is a
 *  sub-pixel smear that antialiases into the background. */
const MIN_MARK_PX = 3

/** Stroke width, in flow units, for `<MiniMap nodeStrokeWidth>`.
 *
 *  A session's main thread is one tall column, so a few hundred calls make the
 *  graph tens of thousands of flow units tall while the minimap stays 150px —
 *  an 80-unit node then renders at a fifth of a pixel. Non-zero, and invisible.
 *  React Flow scales the minimap's stroke in *flow* units too, so padding each
 *  rect by a size-derived stroke restores a legible mark without touching the
 *  real canvas.
 *
 *  Returns 0 — no stroke at all, overriding React Flow's default 2 — whenever
 *  the graph is small enough that nodes already clear `MIN_MARK_PX`, so a
 *  two-node session gets plain rects rather than a blob. */
export function minimapStrokeWidth(nodes: readonly FlowNode[]): number {
  if (nodes.length === 0) return 0
  let top = Infinity
  let bottom = -Infinity
  for (const n of nodes) {
    if (n.position.y < top) top = n.position.y
    if (n.position.y + n.height > bottom) bottom = n.position.y + n.height
  }
  const flowHeight = bottom - top
  if (!Number.isFinite(flowHeight) || flowHeight <= 0) return 0
  // Flow units per minimap pixel, then the padding that lifts NODE_H to the
  // floor. Stroke straddles the rect edge, so it adds its full width overall.
  const unitsPerPx = flowHeight / MINIMAP_H
  return Math.max(0, Math.round(MIN_MARK_PX * unitsPerPx - NODE_H))
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

/** Per-tool node colour.
 *
 *  A session's main thread is one tall column of `kind: tool` nodes, and until
 *  now every one of them carried the same grey left border — so scanning for
 *  "where did it start editing files" meant reading every label. Giving each
 *  tool *name* its own stable colour turns that column into a scannable stripe.
 *
 *  Two-part, deliberately: a hand-assigned index for the tools that actually
 *  dominate a transcript (Bash/Read/Edit are ~80% of all calls, and those must
 *  never sit on neighbouring hues), and a hash for everything else — the tail
 *  is open-ended (`mcp__*` names, whatever ships next month), so a pure lookup
 *  table would go stale and hand a new tool the "unknown" grey it used to have.
 *
 *  Hues avoid the three bands already spent on the other node kinds — cyan
 *  (session), violet (skill), magenta (agent) — so a tool never impersonates
 *  the structural colours it sits between. */
const TOOL_PALETTE = [
  'hsl(28, 85%, 60%)', //  0 orange
  'hsl(206, 80%, 62%)', //  1 blue
  'hsl(150, 65%, 52%)', //  2 green
  'hsl(340, 75%, 62%)', //  3 rose
  'hsl(48, 90%, 58%)', //  4 yellow
  'hsl(170, 58%, 48%)', //  5 teal
  'hsl(96, 55%, 55%)', //  6 olive
  'hsl(276, 65%, 68%)', //  7 purple
  'hsl(14, 78%, 62%)', //  8 vermilion
  'hsl(62, 62%, 56%)', //  9 chartreuse
  'hsl(220, 68%, 68%)', // 10 indigo
  'hsl(4, 72%, 62%)', // 11 red
  'hsl(190, 45%, 55%)', // 12 slate-cyan
  'hsl(35, 45%, 52%)', // 13 tan
  'hsl(300, 40%, 62%)', // 14 mauve
  'hsl(128, 40%, 46%)', // 15 forest
  'hsl(240, 35%, 66%)', // 16 periwinkle
  'hsl(84, 35%, 48%)', // 17 moss
]

/** Fixed slots. Two rules, in tension, and the second is why this is a table
 *  rather than a pure hash:
 *
 *  1. The high-volume tools must never collide — `Bash`/`Read`/`Edit` alone are
 *     ~80% of a transcript, so one accidental shared hue flattens most of the
 *     column back to the single stripe this replaces. Measured against a real
 *     session, a 12-entry palette put `Bash` and `EnterWorktree` on the same
 *     orange; the palette is 18 wide for that reason.
 *  2. Where two names *are* one act, they share deliberately. `Task`/`Agent`
 *     are the same spawn under two spellings; the `Task*` management tools,
 *     the worktree pair and the send family each read as one thing in a column
 *     and colouring them apart would invent a distinction. */
/** The hash draws only from slots at or above this one, so no unknown name can
 *  land on a *high-volume* tool's colour — measured, `advisor` hashed straight
 *  onto `Write`'s rose before the split.
 *
 *  It is a floor, not a private range: the table still uses 12–17 for its
 *  low-traffic families, so an unknown name may share with `EnterWorktree` or
 *  the `Task*` group. That is the intended trade — two rare things sharing a
 *  hue is a far cheaper mistake than a rare one impersonating `Bash`. */
const FALLBACK_FROM = 12

const TOOL_SLOT: Record<string, number> = {
  Bash: 0,
  Read: 1,
  Edit: 2,
  Write: 3,
  WebFetch: 4,
  WebSearch: 5,
  // Same act under three spellings across Claude Code versions.
  Agent: 7,
  Task: 7,
  Skill: 6,
  // Both search for files; one colour is the honest encoding.
  Glob: 8,
  Grep: 8,
  ToolSearch: 9,
  StructuredOutput: 10,
  AskUserQuestion: 11,
  EnterWorktree: 12,
  ExitWorktree: 12,
  TaskCreate: 13,
  TaskUpdate: 13,
  TaskStop: 13,
  TaskList: 13,
  TaskGet: 13,
  TaskOutput: 13,
  Monitor: 14,
  Workflow: 15,
  SendMessage: 16,
  SendUserFile: 16,
  PushNotification: 16,
  ScheduleWakeup: 17,
  CronCreate: 17,
  CronList: 17,
  CronDelete: 17,
}

/** Colour for a tool node, keyed on the tool's name. Stable across reloads and
 *  across sessions — the same tool is the same colour everywhere, which is the
 *  whole point — and total: an unrecognised name still gets a real colour. */
export function toolColor(name: string): string {
  const slot = TOOL_SLOT[name]
  if (slot !== undefined) return TOOL_PALETTE[slot]
  // FNV-1a, 32-bit — any stable string hash would do; this one is four lines.
  let h = 0x811c9dc5
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return TOOL_PALETTE[FALLBACK_FROM + ((h >>> 0) % (TOOL_PALETTE.length - FALLBACK_FROM))]
}

/** Tools whose `target` is a path, so the node shows its last segment. The
 *  server stores the full path (it is the unambiguous thing to store); which
 *  part of it fits in 210px is a rendering question, so it is decided here. */
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'NotebookEdit', 'Artifact'])

/** The node's second line: what the call acted on, shortened to what the box
 *  can hold. A file tool shows the file name (`cc.rs`, not 58 characters of
 *  `/Users/…/src/core/`); everything else — a Bash command, a URL, a query —
 *  shows the target as stored, since its front is already the informative end.
 *
 *  Path shortening keys on the tool name first and falls back to "looks like a
 *  path" (leading `/`, `./` or `~`, no spaces) so an unrecognised file-ish tool
 *  still reads well. A Bash command is never shortened this way even when it
 *  starts with an absolute path, because it holds spaces the moment it takes an
 *  argument — and `/usr/local/bin/foo --flag` wants its flags, not `foo`.
 *
 *  The full value stays available as the node's hover title: this returns the
 *  display form only, and never claims to round-trip. */
export function shortTarget(node: Pick<CcGraphNode, 'name' | 'target'>): string | null {
  const t = node.target
  if (!t) return null
  const pathLike = FILE_TOOLS.has(node.name) || (/^[~./]/.test(t) && !/\s/.test(t))
  if (!pathLike) return t
  // `filter(Boolean)` so a trailing slash yields the directory name rather
  // than an empty string.
  const parts = t.split('/').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : t
}
