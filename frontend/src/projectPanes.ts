// The project page's "Custom" tab (mesa task 843): the pane tree a user builds
// by dragging view tabs (Dashboard, Board, Storyboards, …) into the main area,
// plus the machine-local memory that keeps it across navigations.
//
// Two deliberate shapes:
// - **A view appears at most once.** A leaf's id *is* its tab name, so dragging
//   an already-open view somewhere else moves that pane rather than opening a
//   second copy of it — which is also what lets every gesture here reuse
//   `lib/paneTree.ts` unchanged (that engine keys only off opaque leaf ids).
// - **The drop itself is `resolveDrop`.** A tab dragged from the strip is
//   appended to the tree and then dropped exactly like an existing pane would
//   be, so the edge/center zones, the split orientation and the canonicalization
//   all match the Terminal page and the Agent sidebar instead of re-deriving a
//   second interaction model.
//
// Persistence is localStorage, keyed by project — machine-local, like
// lastView.ts and lastFolder.ts, never project or server data.

import type { ClientRect } from '@dnd-kit/core'
import type { ProjectTab } from './lastView'
import {
  collectLeafIds,
  DEFAULT_RATIO,
  findPathToLeaf,
  newSplitId,
  removeLeaf,
  replaceAtPath,
  resolveDrop,
  type LeafNode,
  type SplitNode,
} from './lib/paneTree'

// The draggable views. `custom` itself is not one of them — it is the tab that
// *shows* this tree, so it can never be a pane inside it.
export const PANE_TABS: readonly PaneTab[] = [
  'dashboard',
  'board',
  'storyboards',
  'git',
  'files',
  'terminal',
  'settings',
]

// Every project tab except Custom itself — Custom is the tab that *shows*
// this tree, so it can never be a pane inside it. Derived from the routing
// union rather than restated, so a tab that is *not* a project route cannot
// be listed below; `LABELS` is what forces a NEW project tab to be decided
// about here, since it must name every member of this union.
export type PaneTab = Exclude<ProjectTab, 'custom'>

// The drag payload a view tab travels as. A dedicated type, not `text/plain`:
// the Files tab drags file paths and editor tabs around as `text/plain`, and
// a pane must accept exactly one of those two kinds of drag. `dragover` can
// only read `dataTransfer.types`, never the value, so the discrimination has
// to live in the type itself.
export const TAB_DRAG_MIME = 'application/x-mesa-tab'

export type ViewLeaf = LeafNode<'view'>
export type PaneRoot = SplitNode<'view'>

export function isPaneTab(value: unknown): value is PaneTab {
  return typeof value === 'string' && (PANE_TABS as readonly string[]).includes(value)
}

const LABELS: Record<PaneTab, string> = {
  dashboard: 'Dashboard',
  board: 'Board',
  storyboards: 'Storyboards',
  git: 'Git',
  files: 'Files',
  terminal: 'Terminal',
  settings: 'Settings',
}

export function paneLabel(tab: PaneTab): string {
  return LABELS[tab]
}

function leaf(tab: PaneTab): ViewLeaf {
  return { kind: 'leaf', contentKind: 'view', id: tab }
}

/** The tree a single view fills on its own — the shape every non-Custom tab is
 *  equivalent to, and therefore what a drop onto a plain tab's content area
 *  starts from. */
export function singlePane(tab: PaneTab): PaneRoot {
  return {
    kind: 'split',
    id: newSplitId(),
    orientation: 'row',
    children: [{ ratio: DEFAULT_RATIO, node: leaf(tab) }],
  }
}

function appendPane(root: PaneRoot, tab: PaneTab): PaneRoot {
  return replaceAtPath(root, [], (n) => ({
    ...n,
    children: [...n.children, { ratio: DEFAULT_RATIO, node: leaf(tab) }],
  }))
}

/** Every view currently in the tree, in tree order. */
export function paneTabs(root: PaneRoot): PaneTab[] {
  return collectLeafIds(root).filter(isPaneTab)
}

export function closePane(root: PaneRoot, tab: PaneTab): PaneRoot {
  return normalizeRatios(removeLeaf(root, tab))
}

export function isEmpty(root: PaneRoot): boolean {
  return root.children.length === 0
}

/**
 * Rescales every split's children so their ratios sum to the number of them,
 * proportions untouched.
 *
 * A pane's ratio is its CSS `flex-grow`, and flexbox only hands out free space
 * in proportion to the grow factors *when they sum to at least 1* — below that
 * it distributes exactly that fraction and leaves the rest of the row empty.
 * `canonicalize`'s splice rule divides a spliced-in child's ratios by their
 * own sum to fit the wrapper's ratio budget, so two successive splits of the
 * same pair (drop a view in, then drag its pane to the other side) walk the
 * budget down — 1 → 0.5 → 0.25 — and the second one leaves half the tab empty.
 *
 * Renormalizing after each completed gesture keeps the sum where flexbox needs
 * it. It is deliberately NOT applied while a divider is being dragged: that
 * drag writes absolute ratios derived from the pair's size at mousedown, so
 * rescaling underneath it mid-gesture would make the divider jump.
 */
export function normalizeRatios(root: PaneRoot): PaneRoot {
  function walk<T extends PaneRoot['children'][number]['node']>(node: T): T {
    if (node.kind === 'leaf') return node
    const sum = node.children.reduce((s, c) => s + c.ratio, 0)
    const scale = sum > 0 ? node.children.length / sum : 1
    return {
      ...node,
      children: node.children.map((c) => ({ ratio: c.ratio * scale, node: walk(c.node) })),
    }
  }
  return walk(root)
}

/**
 * The drop itself: `tab` was dragged from the strip onto the pane showing
 * `overId`, at `pointer` inside that pane's `overRect`.
 *
 * A view already in the tree is removed first, so this doubles as "move that
 * pane" (a leaf id is its tab name — there is no second copy to open). The
 * dragged tab is then appended to root and handed to `resolveDrop`, which is
 * what makes an edge-zone drop a new split and a center-zone drop a plain
 * insertion beside the target, identically to the Terminal page.
 */
export function dropTab(
  root: PaneRoot,
  tab: PaneTab,
  overId: string,
  pointer: { x: number; y: number },
  overRect: ClientRect,
): PaneRoot {
  // Dropped onto its own pane: there is nothing to rearrange, and removing it
  // first would leave the drop with no target at all.
  if (overId === tab) return root
  const without = removeLeaf(root, tab)
  if (isEmpty(without)) return singlePane(tab)
  if (findPathToLeaf(without, overId) === null) return normalizeRatios(appendPane(without, tab))
  const appended = appendPane(without, tab)
  return normalizeRatios(
    (resolveDrop(appended, tab, overId, pointer, overRect) as PaneRoot | null) ?? appended,
  )
}

/**
 * Where a task link on this project's board points, given the hash it is
 * rendered under: `#/projects/7/custom/tasks/12` while the Custom layout is
 * open, the plain `#/projects/7/tasks/12` everywhere else.
 *
 * A board card's link is what opens the task panel, and the panel is a route —
 * so without this, clicking a card inside a Board *pane* would navigate to a
 * route that is not the Custom tab and tear the whole layout down to open one
 * task. Deciding it from the current hash keeps that knowledge in one function
 * instead of threading a base href down through the board's card tree.
 */
export function taskHrefFrom(hash: string, projectId: number, taskId: number): string {
  const base = `#/projects/${projectId}`
  return hash.startsWith(`${base}/custom`)
    ? `${base}/custom/tasks/${taskId}`
    : `${base}/tasks/${taskId}`
}

// --- Machine-local memory --------------------------------------------

const KEY = 'mesa-project-panes'

/** Total: anything that is not a well-formed tree of known view leaves reads
 *  back as absent, so a hand-edited or stale entry can never crash the page. */
function parseNode(value: unknown): PaneRoot | ViewLeaf | null {
  if (value === null || typeof value !== 'object') return null
  const n = value as Record<string, unknown>
  if (n.kind === 'leaf') return isPaneTab(n.id) ? leaf(n.id) : null
  if (n.kind !== 'split') return null
  if (n.orientation !== 'row' && n.orientation !== 'column') return null
  if (!Array.isArray(n.children)) return null
  const children = []
  for (const raw of n.children) {
    if (raw === null || typeof raw !== 'object') return null
    const c = raw as Record<string, unknown>
    const node = parseNode(c.node)
    if (node === null) return null
    const ratio = typeof c.ratio === 'number' && c.ratio > 0 ? c.ratio : DEFAULT_RATIO
    children.push({ ratio, node })
  }
  return {
    kind: 'split',
    id: typeof n.id === 'string' ? n.id : newSplitId(),
    orientation: n.orientation,
    children,
  }
}

export function parseLayout(value: unknown): PaneRoot | null {
  const node = parseNode(value)
  if (node === null || node.kind !== 'split') return null
  // A tree holding the same view twice is not one this module can produce
  // (ids are tab names); reject it rather than render two panes that every
  // gesture would then treat as one.
  const tabs = paneTabs(node)
  if (new Set(tabs).size !== tabs.length) return null
  return node
}

function readAll(): Record<string, PaneRoot> {
  const out: Record<string, PaneRoot> = {}
  let parsed: unknown
  try {
    parsed = JSON.parse(localStorage.getItem(KEY) ?? '')
  } catch {
    return out
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return out
  for (const [id, raw] of Object.entries(parsed as Record<string, unknown>)) {
    const layout = parseLayout(raw)
    if (layout !== null && !isEmpty(layout)) out[id] = layout
  }
  return out
}

export function getLayout(projectId: number): PaneRoot | null {
  return readAll()[String(projectId)] ?? null
}

/** Storing an empty tree is storing nothing — closing the last pane is what
 *  takes the Custom tab back off the strip. */
export function setLayout(projectId: number, root: PaneRoot | null): void {
  const all = readAll()
  if (root === null || isEmpty(root)) delete all[String(projectId)]
  else all[String(projectId)] = root
  localStorage.setItem(KEY, JSON.stringify(all))
}
