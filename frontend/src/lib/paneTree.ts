import { arrayMove } from '@dnd-kit/sortable'
import type { ClientRect } from '@dnd-kit/core'

// --- Split-tree engine ------------------------------------------------
//
// Extracted out of `AgentSidebar.tsx` (mesa task 395 / .scratch/arch.md §2)
// so a second pane-tree surface (the Terminal page) can reuse the exact
// same resize/split/rearrange/canonicalization behavior instead of
// re-deriving it. Every type/function here is content-agnostic — it keys
// only off a leaf's opaque `id` string, never its content — so it's
// generalized over the leaf's `contentKind` type parameter `K` (each
// caller's own union, e.g. `'agent'` for the sidebar, `'shell'` for
// Terminal) rather than hardcoding either caller's shape.
//
// What stays private to each caller: anything content/session-specific
// (agent-pane construction, all rendering/chrome, the divider-drag and
// dnd-kit wiring as component-local effects that call into these pure
// functions).

export type DropEdge = 'left' | 'right' | 'top' | 'bottom'

export type LeafNode<K extends string = string> = { kind: 'leaf'; contentKind: K; id: string }

export type SplitChild<K extends string = string> = { ratio: number; node: PaneNode<K> }

export type SplitNode<K extends string = string> = {
  kind: 'split'
  // Stable id for nested-split React keys — a leaf already has a natural
  // key (its own id); a split has none, so mint one at creation and carry
  // it through every rebuild/canonicalize instead of regenerating it on
  // render (which would break React's reconciliation on every toggle).
  id: string
  orientation: 'row' | 'column' // row = side-by-side, column = stacked
  children: SplitChild<K>[]
}

export type PaneNode<K extends string = string> = LeafNode<K> | SplitNode<K>

export const MIN_PANE_PX = 80 // floor on a pane's own height during divider drag
export const DEFAULT_RATIO = 1

// `crypto.randomUUID` is a secure-context-only API — accessing mesa over
// LAN (`mesa serve --lan`) is plain HTTP, so WebKit/Safari on a real iOS
// device treats the origin as insecure and leaves it undefined, crashing
// the whole sidebar (commit b4a7a61, mesa task 391). These ids are just
// split-tree React keys, not security-sensitive, so a Math.random fallback
// is fine — and load-bearing: the Terminal page mints a leaf id via this
// same function on every new pane, and it is reachable under `--lan` too.
export function newSplitId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

export function emptyRoot<K extends string = string>(): SplitNode<K> {
  return { kind: 'split', id: newSplitId(), orientation: 'column', children: [] }
}

/**
 * Collapses a tree bottom-up until none of its 3 rules apply anywhere:
 *  (a) drop an empty split child entirely,
 *  (b) inline a singleton split child (its one grandchild takes over the
 *      wrapper's own ratio slot),
 *  (c) splice a same-orientation split child's children directly into this
 *      level, rescaled to fit inside the child's ratio budget — flex-grow
 *      only competes among true siblings, so a same-orientation wrapper is
 *      pure nesting with no visual effect.
 * Rule (c) is what makes toggling a divider and toggling it back a true
 * round trip instead of an ever-growing nest. Called by `replaceAtPath` on
 * every mutation, so callers never have to remember to call it themselves.
 */
export function canonicalize<K extends string>(node: PaneNode<K>): PaneNode<K> {
  if (node.kind === 'leaf') return node
  let children: SplitChild<K>[] = node.children.map((c) => ({ ratio: c.ratio, node: canonicalize(c.node) }))
  let changed = true
  while (changed) {
    changed = false
    const next: SplitChild<K>[] = []
    for (const c of children) {
      if (c.node.kind === 'split' && c.node.children.length === 0) {
        changed = true
        continue
      }
      if (c.node.kind === 'split' && c.node.children.length === 1) {
        next.push({ ratio: c.ratio, node: c.node.children[0].node })
        changed = true
        continue
      }
      if (c.node.kind === 'split' && c.node.orientation === node.orientation) {
        const sum = c.node.children.reduce((s, cc) => s + cc.ratio, 0) || 1
        for (const cc of c.node.children) next.push({ ratio: (cc.ratio / sum) * c.ratio, node: cc.node })
        changed = true
        continue
      }
      next.push(c)
    }
    children = next
  }
  return { kind: 'split', id: node.id, orientation: node.orientation, children }
}

/** `[]` is root itself; `[2]` is `root.children[2].node`; `[2, 0]` is that node's own `children[0].node`, etc. */
export function getNodeAtPath<K extends string>(root: SplitNode<K>, path: number[]): PaneNode<K> {
  let node: PaneNode<K> = root
  for (const i of path) {
    if (node.kind !== 'split') throw new Error('getNodeAtPath: path runs through a leaf')
    node = node.children[i].node
  }
  return node
}

/**
 * Rebuilds only the spine from `root` down to the split node at `path`,
 * applying `fn` there, and canonicalizes the whole result before returning
 * — the single choke point every tree mutation goes through.
 */
export function replaceAtPath<K extends string>(
  root: SplitNode<K>,
  path: number[],
  fn: (n: SplitNode<K>) => SplitNode<K>,
): SplitNode<K> {
  function rebuild(node: SplitNode<K>, rest: number[]): SplitNode<K> {
    if (rest.length === 0) return fn(node)
    const [i, ...tail] = rest
    const childNode = node.children[i].node
    if (childNode.kind !== 'split') throw new Error('replaceAtPath: path runs through a leaf')
    const children = node.children.map((c, idx) =>
      idx === i ? { ratio: c.ratio, node: rebuild(childNode, tail) } : c,
    )
    return { ...node, children }
  }
  return canonicalize(rebuild(root, path)) as SplitNode<K>
}

export function findPathToLeaf<K extends string>(root: SplitNode<K>, id: string): number[] | null {
  for (let i = 0; i < root.children.length; i++) {
    const child = root.children[i].node
    if (child.kind === 'leaf') {
      if (child.id === id) return [i]
    } else {
      const sub = findPathToLeaf(child, id)
      if (sub) return [i, ...sub]
    }
  }
  return null
}

export function collectLeafIds<K extends string>(node: PaneNode<K>): string[] {
  if (node.kind === 'leaf') return [node.id]
  return node.children.flatMap((c) => collectLeafIds(c.node))
}

export function removeLeaf<K extends string>(root: SplitNode<K>, id: string): SplitNode<K> {
  const path = findPathToLeaf(root, id)
  if (!path) return root
  const parentPath = path.slice(0, -1)
  const i = path[path.length - 1]
  return replaceAtPath(root, parentPath, (n) => ({
    ...n,
    children: n.children.filter((_, idx) => idx !== i),
  }))
}

/**
 * Toggles the orientation of the divider between `children[i]`/`children[i+1]`
 * of the split node at `path`: extracts that pair, wraps it in a NEW split
 * node with the OPPOSITE orientation (ratio = the pair's combined ratio), and
 * splices that single node back into the same slot. The familiar "flip a
 * 2-child split in place" case is not a separate code path — it's what
 * `canonicalize`'s singleton-inline rule (via `replaceAtPath`) collapses this
 * same general operation down to automatically when `n.children.length === 2`.
 */
export function toggleDivider<K extends string>(root: SplitNode<K>, path: number[], i: number): SplitNode<K> {
  return replaceAtPath(root, path, (n) => {
    const a = n.children[i]
    const b = n.children[i + 1]
    const wrapper: SplitNode<K> = {
      kind: 'split',
      id: newSplitId(),
      orientation: n.orientation === 'row' ? 'column' : 'row',
      children: [a, b],
    }
    const children = [
      ...n.children.slice(0, i),
      { ratio: a.ratio + b.ratio, node: wrapper },
      ...n.children.slice(i + 2),
    ]
    return { ...n, children }
  })
}

/**
 * Moves the leaf at `fromPath` out of its current split and inserts it at
 * `toIndex` in the DIFFERENT split at `toPath`, then canonicalizes once.
 * The moved leaf's own ratio is dropped — the destination slot always gets
 * `DEFAULT_RATIO`, matching how a reopened pane gets no special ratio
 * treatment (arch.md §3).
 *
 * Deliberately a single top-down rebuild over the ORIGINAL tree's indices,
 * not two sequential `replaceAtPath` calls (each of which canonicalizes).
 * Canonicalizing right after the removal alone could prune/inline the
 * source's now-empty-or-singleton parent split, shifting a LATER sibling's
 * index — which would silently invalidate a `toPath`/`toIndex` computed
 * against the pre-removal tree if that sibling happens to sit on (or past)
 * the destination's branch. Applying both the removal and the insertion in
 * one pass, each still keyed off the untouched original indices, then
 * canonicalizing exactly once at the end avoids that class of bug entirely.
 */
export function moveLeaf<K extends string>(
  root: SplitNode<K>,
  fromPath: number[],
  toPath: number[],
  toIndex: number,
): SplitNode<K> {
  const leaf = getNodeAtPath(root, fromPath)
  if (leaf.kind !== 'leaf') return root
  const fromParentPath = fromPath.slice(0, -1)
  const fromIndex = fromPath[fromPath.length - 1]

  function rebuild(node: SplitNode<K>, path: number[]): SplitNode<K> {
    const atFromParent =
      path.length === fromParentPath.length && path.every((v, k) => v === fromParentPath[k])
    const atToParent = path.length === toPath.length && path.every((v, k) => v === toPath[k])

    let children = node.children.map((c, i) => {
      const onFromBranch = fromParentPath.length > path.length && fromParentPath[path.length] === i
      const onToBranch = toPath.length > path.length && toPath[path.length] === i
      if ((onFromBranch || onToBranch) && c.node.kind === 'split') {
        return { ratio: c.ratio, node: rebuild(c.node, [...path, i]) }
      }
      return c
    })

    if (atFromParent) children = children.filter((_, idx) => idx !== fromIndex)
    if (atToParent) {
      children = [...children]
      children.splice(toIndex, 0, { ratio: DEFAULT_RATIO, node: leaf })
    }
    return { ...node, children }
  }

  return canonicalize(rebuild(root, [])) as SplitNode<K>
}

/**
 * Wraps the leaf at `toPath` together with the leaf dragged from `fromPath`
 * into a NEW split node — orientation from `edge` (row for left/right,
 * column for top/bottom), order from `edge` (left/top puts the dragged
 * leaf first) — replacing the target's own slot with that wrapper. This is
 * the drag-TO-SPLIT gesture (edge zones, story 387); `moveLeaf` above is
 * drag-to-REORDER (center zone, story 375) — the caller picks between them
 * per drop position (`computeDropEdge`), not this function.
 *
 * The wrapper inherits the target's own ratio in ITS parent, so sibling
 * sizing elsewhere is untouched; inside the wrapper the target and the
 * newly split-in leaf share `DEFAULT_RATIO` evenly, matching how a
 * freshly moved/reopened pane always gets an unspecial-cased ratio
 * (`moveLeaf`'s own comment). If the wrapper's orientation happens to
 * match its own parent's, `canonicalize` immediately splices its two
 * children back out flat — which is exactly the right outcome, not a
 * bug: dropping on the left/right edge of a pane that already lives in a
 * row split just means "insert as that pane's row-sibling here," same
 * open question `toggleDivider` already answers for the adjacent-pair
 * case. No orientation-vs-parent special-casing is needed here because
 * of that.
 *
 * Same single-pass, both-paths-keyed-to-the-ORIGINAL-tree rebuild as
 * `moveLeaf`, for the same reason given there — but the removal and the
 * replacement are both decided in ONE `map` over each split's original
 * `children` (index-only, no early filtering) precisely because `fromPath`
 * and `toPath` can share a parent here (dragging one sibling onto another
 * within the same split, e.g. building a nested split out of two flat
 * row/column siblings) — a case `moveLeaf` never has to handle since
 * `resolveDrop` only calls it when the two parents differ. Filtering
 * out `fromIndex` before locating `toIndex` would shift indices out from
 * under `atToParent`'s lookup whenever `fromIndex < toIndex`; deciding
 * both against the same original array read sidesteps that entirely.
 */
export function splitLeafAt<K extends string>(
  root: SplitNode<K>,
  fromPath: number[],
  toPath: number[],
  edge: DropEdge,
): SplitNode<K> {
  const leaf = getNodeAtPath(root, fromPath)
  const target = getNodeAtPath(root, toPath)
  if (leaf.kind !== 'leaf' || target.kind !== 'leaf' || leaf.id === target.id) return root
  const fromParentPath = fromPath.slice(0, -1)
  const fromIndex = fromPath[fromPath.length - 1]
  const toParentPath = toPath.slice(0, -1)
  const toIndex = toPath[toPath.length - 1]
  const orientation: 'row' | 'column' = edge === 'left' || edge === 'right' ? 'row' : 'column'
  const draggedFirst = edge === 'left' || edge === 'top'

  function rebuild(node: SplitNode<K>, path: number[]): SplitNode<K> {
    const atFromParent = path.length === fromParentPath.length && path.every((v, k) => v === fromParentPath[k])
    const atToParent = path.length === toParentPath.length && path.every((v, k) => v === toParentPath[k])

    const recursed = node.children.map((c, i) => {
      const onFromBranch = fromParentPath.length > path.length && fromParentPath[path.length] === i
      const onToBranch = toParentPath.length > path.length && toParentPath[path.length] === i
      if ((onFromBranch || onToBranch) && c.node.kind === 'split') {
        return { ratio: c.ratio, node: rebuild(c.node, [...path, i]) }
      }
      return c
    })

    const children = recursed
      .map((c, idx) => {
        if (atFromParent && idx === fromIndex) return null
        if (atToParent && idx === toIndex) {
          const wrapper: SplitNode<K> = {
            kind: 'split',
            id: newSplitId(),
            orientation,
            children: draggedFirst
              ? [{ ratio: DEFAULT_RATIO, node: leaf }, { ratio: DEFAULT_RATIO, node: target }]
              : [{ ratio: DEFAULT_RATIO, node: target }, { ratio: DEFAULT_RATIO, node: leaf }],
          }
          return { ratio: c.ratio, node: wrapper }
        }
        return c
      })
      .filter((c): c is SplitChild<K> => c !== null)

    return { ...node, children }
  }

  return canonicalize(rebuild(root, [])) as SplitNode<K>
}

// --- Auto-tiled grid layout (mesa task 466) ---------------------------
//
// The gestures above are all user-driven — they take a tree and one drag and
// return a new tree. These two are the opposite direction: given only a set
// of panes and the space available, lay them out from scratch. Used by the
// Agent sidebar's Auto Tile mode, which owns the layout while it's on (the
// whole point of the mode is that you never arrange panes by hand).

// A terminal narrower than this wraps its own output into slivers, which is
// the failure mode a 4-across grid in a 500px sidebar would produce — so
// column count is capped by how many panes of at least this width fit,
// before any aspect-ratio preference is considered. This is why a narrow
// sidebar still gets a plain vertical stack no matter how many agents run.
export const MIN_GRID_PANE_PX = 360
// Terminals read better wide than tall (long lines, short scrollback view),
// so the "ideal" cell is somewhat wider than square rather than 1:1.
const TARGET_CELL_ASPECT = 1.4
// Per unused grid slot, added to a candidate's score — breaks ties toward
// layouts that fill their last row (3 panes prefer 1x3 or a 2-col grid over
// 3 columns with two empty cells beneath).
const EMPTY_SLOT_PENALTY = 0.15

/**
 * How many columns `n` panes should tile into inside a `width`x`height` box.
 * Scores every column count that clears `MIN_GRID_PANE_PX` by how far its
 * resulting cell aspect sits from `TARGET_CELL_ASPECT` (log-scale, so
 * "twice as wide as ideal" and "half as wide" are penalized equally),
 * plus a small penalty per empty slot, and returns the best.
 *
 * Deliberately measured off the tile area's LIVE rect rather than a
 * breakpoint on the viewport: this box is resizable three independent ways
 * (sidebar drag, maximize, list-rail collapse), so a viewport-derived
 * guess would be wrong in most of those states.
 */
export function gridColumns(n: number, width: number, height: number): number {
  if (n <= 1 || width <= 0 || height <= 0) return 1
  const maxCols = Math.max(1, Math.min(n, Math.floor(width / MIN_GRID_PANE_PX)))
  let best = 1
  let bestScore = Infinity
  for (let c = 1; c <= maxCols; c++) {
    const rows = Math.ceil(n / c)
    const aspect = width / c / (height / rows)
    const score = Math.abs(Math.log(aspect / TARGET_CELL_ASPECT)) + (c * rows - n) * EMPTY_SLOT_PENALTY
    if (score < bestScore) {
      bestScore = score
      best = c
    }
  }
  return best
}

/**
 * Builds a fresh tree tiling `leaves` into `cols` columns, filled
 * row-major (pane `i` lands in column `i % cols`) so reading order across
 * the top row matches the order the leaves came in.
 *
 * One column is a flat column split, not a row split wrapping one child —
 * same tree `emptyRoot`+`insertLeaf` would have produced, so toggling Auto
 * Tile on in a narrow sidebar is a no-op on the layout rather than a
 * reshuffle. Wider grids are a row of column splits; `canonicalize`
 * inlines any column that ended up with a single leaf.
 */
export function buildGrid<K extends string>(leaves: LeafNode<K>[], cols: number): SplitNode<K> {
  if (leaves.length === 0) return emptyRoot<K>()
  const c = Math.max(1, Math.min(cols, leaves.length))
  const wrap = (l: LeafNode<K>): SplitChild<K> => ({ ratio: DEFAULT_RATIO, node: l })
  if (c === 1) {
    return { kind: 'split', id: newSplitId(), orientation: 'column', children: leaves.map(wrap) }
  }
  const columns: LeafNode<K>[][] = Array.from({ length: c }, () => [])
  leaves.forEach((l, i) => columns[i % c].push(l))
  return canonicalize({
    kind: 'split',
    id: newSplitId(),
    orientation: 'row',
    children: columns.map((col) => ({
      ratio: DEFAULT_RATIO,
      node: { kind: 'split', id: newSplitId(), orientation: 'column', children: col.map(wrap) },
    })),
  }) as SplitNode<K>
}

// Center 40%x40% of the target pane (|dx|,|dy| both under this) is the
// "reorder" zone — `moveLeaf`/`arrayMove`, no new split, no indicator. The
// outer 60% is quartered into left/right/top/bottom triangles by whichever
// axis deviates from center more, the standard tiling-WM/VS-Code docking
// read on a drop point (arch note for story 387).
//
// Takes the raw POINTER position, not the dragged pane's own (translated)
// bounding box — deliberately: every pane here spans the sidebar's full
// width/height at some point (there's no independent left/right column
// until a row split already exists), so a pane's own box can be far wider
// or taller than the target it's hovering. Zoning off the dragged box's
// CENTER would tie the detected edge to that box's size and grab-point
// offset instead of to where the user is actually pointing — dragging a
// full-width pane by a grip near its own left edge could never reach a
// target's "left" zone at all, since the box's center would have to
// travel the same huge distance the pointer does, not just the pointer's
// own delta. The pointer itself has no such size-dependence, so it's the
// one thing that reads the same regardless of what's being dragged.
const CENTER_ZONE_HALF = 0.2

export function computeDropEdge(pointer: { x: number; y: number }, overRect: ClientRect): DropEdge | null {
  if (overRect.width <= 0 || overRect.height <= 0) return null
  const dx = (pointer.x - overRect.left) / overRect.width - 0.5
  const dy = (pointer.y - overRect.top) / overRect.height - 0.5
  if (Math.max(Math.abs(dx), Math.abs(dy)) < CENTER_ZONE_HALF) return null
  return Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'top' : 'bottom'
}

// One function every hardcoded `e.clientY`/`e.clientX` read goes through:
// a row split's divider drags along X, a column split's along Y. Typed
// structurally (not `MouseEvent`) so it accepts both a React synthetic
// mousedown event and a native `document`-level mousemove event.
export function axisPos(e: { clientX: number; clientY: number }, orientation: 'row' | 'column'): number {
  return orientation === 'row' ? e.clientX : e.clientY
}

/**
 * Given a drop (`activeId` dragged onto `overId`, at pointer position
 * `pointer` over `overId`'s rect `overRect`), decides whether this was a
 * reorder, a cross-split move, or a new split, and returns the resulting
 * tree — `null` means no-op (dropped on itself, or either leaf's path
 * couldn't be found). Pure decision logic lifted out of the
 * `AgentSidebar`'s original `handlePaneDragEnd`, so a second caller
 * (Terminal) matches this exact interaction model instead of risking drift
 * from a hand-copied branch.
 *
 * Edge zone of the drop target (`computeDropEdge`) picks between two
 * gestures:
 *  - center zone → move/reorder: same parent split is a plain sibling
 *    reorder (`arrayMove`); a different parent is a cross-split move,
 *    inserted at `over`'s own index in its split (`moveLeaf`).
 *  - edge zone → drag-TO-SPLIT: wrap the drop target and the dragged leaf
 *    in a NEW split oriented/ordered by the edge (`splitLeafAt`).
 * Either way `overId` is always another leaf's id (each leaf is its own
 * sortable drop target, so the target pane's own already-measured rect is
 * enough for the edge case too).
 */
export function resolveDrop<K extends string>(
  root: SplitNode<K>,
  activeId: string,
  overId: string,
  pointer: { x: number; y: number } | null,
  overRect: ClientRect,
): SplitNode<K> | null {
  if (activeId === overId) return null
  const fromPath = findPathToLeaf(root, activeId)
  const toPath = findPathToLeaf(root, overId)
  if (!fromPath || !toPath) return null
  const edge = pointer ? computeDropEdge(pointer, overRect) : null
  if (edge) return splitLeafAt(root, fromPath, toPath, edge)
  const fromParent = fromPath.slice(0, -1)
  const toParent = toPath.slice(0, -1)
  const samePath = fromParent.length === toParent.length && fromParent.every((v, k) => v === toParent[k])
  const from = fromPath[fromPath.length - 1]
  const to = toPath[toPath.length - 1]
  if (samePath) {
    return replaceAtPath(root, fromParent, (n) => ({ ...n, children: arrayMove(n.children, from, to) }))
  }
  return moveLeaf(root, fromPath, toParent, to)
}
