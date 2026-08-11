// Open-file tabs and the one-level split for the Files tab (mesa task 670).
//
// Same reason `navOrder.ts` exists (CLAUDE.md): the transitions a drag or a
// close resolves to are the part that historically ships wrong, and a
// predicate that decides whether state changes at all belongs somewhere vitest
// can reach it — not inline in a `.tsx` only khora can exercise. `FilesView`
// keeps the fetching, the DOM and the drag *events*; every question of "what
// does the open set look like afterwards" is answered here.
//
// The model is deliberately small: a `left` pane, an optional `right` pane,
// and which of the two is focused. Not a recursive pane tree — the feature is
// one split, side by side, and a tree would be a data structure with no UI
// able to produce most of its states.

/** Which of the (at most two) panes. `'right'` exists only while split. */
export type PaneSide = 'left' | 'right'

/** One pane's open files, in strip order, plus the one it is showing. */
export interface Pane {
  /** Open paths, left to right, unique *within this pane*. */
  tabs: string[]
  /** The rendered file. `null` iff `tabs` is empty. */
  active: string | null
}

/**
 * The whole content half's state.
 *
 * Invariants every exported transition preserves (and `fileTabs.test.ts`
 * asserts): `right === null` implies `focused === 'left'`; a pane's `active`
 * is `null` exactly when its `tabs` are empty and is otherwise a member of
 * them; no pane lists the same path twice.
 *
 * The *same* path may be open in both panes at once — that is what the Split
 * control produces, and it is the one duplicate this model allows. Dedupe is
 * per pane, which is what "clicking a tree row never adds a second tab for a
 * file already in this strip" actually means.
 */
export interface TabsState {
  left: Pane
  /** `null` = not split; the left pane is the whole content area. */
  right: Pane | null
  focused: PaneSide
  /** Left pane's share of the content width, `MIN_RATIO`..`MAX_RATIO`. */
  ratio: number
}

/** The divider's clamp. Neither pane may be dragged to nothing — a zero-width
 *  pane still holds tabs and a focus, so it would be state with no way back. */
export const MIN_RATIO = 0.15
export const MAX_RATIO = 0.85
export const DEFAULT_RATIO = 0.5

export function emptyTabsState(): TabsState {
  return { left: { tabs: [], active: null }, right: null, focused: 'left', ratio: DEFAULT_RATIO }
}

/** The pane on `side`, or `null` when asked for `'right'` while unsplit. */
export function paneOf(state: TabsState, side: PaneSide): Pane | null {
  return side === 'left' ? state.left : state.right
}

/** Every path open in either pane, deduplicated — the key set any per-path
 *  side state (an edit draft, an open history) may keep, so closing the last
 *  tab for a path is what drops it. */
export function openPaths(state: TabsState): string[] {
  const out = new Set(state.left.tabs)
  for (const p of state.right?.tabs ?? []) out.add(p)
  return [...out]
}

function withPane(state: TabsState, side: PaneSide, pane: Pane): TabsState {
  return side === 'left' ? { ...state, left: pane } : { ...state, right: pane }
}

/**
 * Open `path` in whichever pane has focus, and make it that pane's active tab.
 *
 * Already open *in the focused pane* → activate it, no second tab. Already
 * open in the **other** pane and not this one → focus that pane and activate
 * it there rather than minting a duplicate: a tree click means "show me this
 * file", and it already is shown somewhere.
 */
export function openFile(state: TabsState, path: string): TabsState {
  const focused = paneOf(state, state.focused)!
  if (focused.tabs.includes(path)) {
    return withPane(state, state.focused, { ...focused, active: path })
  }
  const other: PaneSide = state.focused === 'left' ? 'right' : 'left'
  const otherPane = paneOf(state, other)
  if (otherPane !== null && otherPane.tabs.includes(path)) {
    return { ...withPane(state, other, { ...otherPane, active: path }), focused: other }
  }
  return withPane(state, state.focused, {
    tabs: [...focused.tabs, path],
    active: path,
  })
}

/** Show an already-open tab, and focus its pane. */
export function activateTab(state: TabsState, side: PaneSide, path: string): TabsState {
  const pane = paneOf(state, side)
  if (pane === null || !pane.tabs.includes(path)) return state
  return { ...withPane(state, side, { ...pane, active: path }), focused: side }
}

/**
 * Step one pane's active tab to its neighbour, wrapping at either end — what
 * the Alt+[ / Alt+] chords do (mesa task 809).
 *
 * Wrapping rather than stopping at the ends, because that is what every editor
 * with this binding does and because a strip is a ring the user cycles rather
 * than a list they arrive at the end of. `null` — no change — when there is
 * nothing to step *to*: a missing pane, an empty one, or a single tab, where
 * wrapping would land back on the tab already showing and cost a render for
 * nothing.
 */
export function cycleTab(
  state: TabsState,
  side: PaneSide,
  forward: boolean,
): TabsState | null {
  const pane = paneOf(state, side)
  if (pane === null || pane.active === null || pane.tabs.length < 2) return null
  const i = pane.tabs.indexOf(pane.active)
  const n = pane.tabs.length
  const next = pane.tabs[(i + (forward ? 1 : n - 1)) % n]
  return activateTab(state, side, next)
}

/** Clicking anywhere in a pane focuses it. A pane that isn't there can't be. */
export function focusPane(state: TabsState, side: PaneSide): TabsState {
  if (side === 'right' && state.right === null) return state
  if (state.focused === side) return state
  return { ...state, focused: side }
}

/** The pane a closed tab leaves behind: its right-hand neighbour becomes
 *  active, else its left-hand one, else nothing is open. */
function paneWithout(pane: Pane, path: string): Pane {
  const i = pane.tabs.indexOf(path)
  if (i < 0) return pane
  const tabs = pane.tabs.filter((p) => p !== path)
  if (pane.active !== path) return { ...pane, tabs }
  const next = tabs[i] ?? tabs[i - 1] ?? null
  return { tabs, active: next }
}

/**
 * Close one tab. Discards nothing else and asks nothing — the app's
 * no-confirmation posture; an unsaved draft for this path goes with it.
 *
 * Emptying a pane while split **collapses** the split, and the survivor takes
 * the full width. Emptying the only pane just leaves its empty state.
 */
export function closeTab(state: TabsState, side: PaneSide, path: string): TabsState {
  const pane = paneOf(state, side)
  if (pane === null || !pane.tabs.includes(path)) return state
  const next = paneWithout(pane, path)
  if (next.tabs.length > 0 || state.right === null) {
    const moved = withPane(state, side, next)
    // Focus follows the click that closed the tab, except onto an empty pane
    // that is about to be the only one anyway.
    return { ...moved, focused: next.tabs.length === 0 && side === 'right' ? 'left' : side }
  }
  // Split, and this pane is now empty: the other one becomes the whole area.
  const survivor = side === 'left' ? state.right! : state.left
  return { left: survivor, right: null, focused: 'left', ratio: state.ratio }
}

/**
 * Split into two panes, the new right one showing the focused pane's active
 * file. `null` — no change — when already split, or when there is nothing open
 * to show in the new pane.
 *
 * The active tab is **copied**, not moved: moving the only tab out of a pane
 * would empty it, which by the rule above collapses the split again, so the
 * control could never do anything from a one-tab pane. This is the one place
 * the same path is open twice.
 */
export function splitPane(state: TabsState): TabsState | null {
  if (state.right !== null) return null
  const active = state.left.active
  if (active === null) return null
  return {
    left: state.left,
    right: { tabs: [active], active },
    focused: 'right',
    ratio: DEFAULT_RATIO,
  }
}

/** Fold a split back to one pane — the focused one survives. A no-op when
 *  there is no split, so the narrow-tier crossing can call it blind. */
export function collapseSplit(state: TabsState): TabsState {
  if (state.right === null) return state
  const survivor = paneOf(state, state.focused)!
  return { left: survivor, right: null, focused: 'left', ratio: state.ratio }
}

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_RATIO
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))
}

export function setRatio(state: TabsState, ratio: number): TabsState {
  if (state.right === null) return state
  const next = clampRatio(ratio)
  return next === state.ratio ? state : { ...state, ratio: next }
}

/** A tab's horizontal extent, as `getBoundingClientRect` reports it. */
export interface TabRect {
  left: number
  right: number
}

/**
 * Where in a strip a pointer at `x` would insert: the index *before* which the
 * dragged tab lands, i.e. `0`..`rects.length`.
 *
 * Midpoint scheme, same as the board's and the nav's — past a tab's centre
 * means after it. Out-of-strip pointers fall out correctly without a special
 * case (left of everything is `0`, right of everything is the end), which is
 * what makes dropping into the strip's empty tail work.
 */
export function dropIndex(rects: readonly TabRect[], x: number): number {
  let i = 0
  while (i < rects.length && x >= (rects[i].left + rects[i].right) / 2) i++
  return i
}

/** Where a tab is being dragged from. */
export interface TabSource {
  side: PaneSide
  path: string
}

/**
 * Move a tab to `index` in the pane on `toSide`, or `null` when the drop
 * changes nothing and no state should be written.
 *
 * `null` for: a drop with no such tab or no such pane; a **same-strip** drop
 * at the tab's own index or the one just past it (both mean "back where it
 * already is" — dropping a tab on itself is one of these); and a cross-pane
 * drop into a pane that is already showing that path as its active tab.
 *
 * A cross-pane move into a pane that *has* the path but isn't showing it
 * activates it there and closes the source copy — never a third tab.
 */
export function moveTab(
  state: TabsState,
  from: TabSource,
  toSide: PaneSide,
  index: number,
): TabsState | null {
  const source = paneOf(state, from.side)
  const dest = paneOf(state, toSide)
  if (source === null || dest === null || !source.tabs.includes(from.path)) return null

  if (from.side === toSide) {
    const at = source.tabs.indexOf(from.path)
    if (index === at || index === at + 1) return null
    const rest = source.tabs.filter((p) => p !== from.path)
    // `index` was measured against the strip *including* the dragged tab, so
    // a rightward move loses one slot once it is lifted out.
    const insertAt = index > at ? index - 1 : index
    const tabs = [...rest.slice(0, insertAt), from.path, ...rest.slice(insertAt)]
    return { ...withPane(state, toSide, { ...source, tabs }), focused: toSide }
  }

  if (dest.tabs.includes(from.path) && dest.active === from.path) return null

  const moved = dest.tabs.includes(from.path)
    ? { ...dest, active: from.path }
    : {
        tabs: [
          ...dest.tabs.slice(0, index),
          from.path,
          ...dest.tabs.slice(index),
        ],
        active: from.path,
      }
  // Close the source copy first, since emptying that pane collapses the split
  // and renumbers which side the destination is on.
  const closed = closeTab(state, from.side, from.path)
  if (closed.right === null) {
    // The source pane was this tab alone: the split is gone and the
    // destination is now the only pane.
    return { ...closed, left: moved, focused: 'left' }
  }
  return { ...withPane(closed, toSide, moved), focused: toSide }
}

/**
 * Enter the split by dropping a tab on the content area's right edge: it moves
 * into a new right pane. `null` when already split (the caller should aim at
 * the right strip instead) or when the tab is the only one in its pane —
 * emptying the source would collapse the split it just created, so there is
 * nothing to do.
 */
export function splitWithTab(state: TabsState, from: TabSource): TabsState | null {
  if (state.right !== null) return null
  if (from.side !== 'left') return null
  if (!state.left.tabs.includes(from.path) || state.left.tabs.length < 2) return null
  return {
    left: paneWithout(state.left, from.path),
    right: { tabs: [from.path], active: from.path },
    focused: 'right',
    ratio: DEFAULT_RATIO,
  }
}
