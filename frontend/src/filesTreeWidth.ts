// Persisted width — and collapsed flag — of the Files tab's file tree (mesa
// task 671), modelled on `navWidth.ts` / `navCollapse.ts`. Machine-local
// (localStorage) and ONE global preference for the Files tab across every
// project: it is a per-browser statement about how much of this screen the
// tree should take, not something about any one repo, so it has no column, no
// route and no place in a backup.
//
// The clamp lives here rather than in `FilesView` because a stored value is as
// untrusted as a mid-drag pointer position — a hand-edited key, a value
// written on a 2560px monitor and reloaded on a 1280px laptop, or a stale
// entry from before the floor changed all have to resolve to something the
// layout can render. Every path out of this module (load and clamp alike)
// returns a number in range or the default; the component never holds an
// out-of-range width, it doesn't merely render one.

const WIDTH_KEY = 'mesa-files-tree-width'
const COLLAPSED_KEY = 'mesa-files-tree-collapsed'

/** Matches the `width: var(--files-tree-width, 304px)` fallback in App.css —
 * the px twin of the `19rem` the tree was hard-coded to before this. Both
 * numbers must move together: the CSS value is what a first visit (nothing
 * stored, no custom property set yet) paints. */
export const DEFAULT_FILES_TREE_WIDTH = 304

/** Narrower than this and tree rows clip to uselessness; the collapse toggle,
 * not the drag, is how you get smaller than a usable tree. */
export const MIN_FILES_TREE_WIDTH = 160

/** Clamp a candidate width into range. `max` is measured live off the layout
 * by the caller (the panes' right edge minus the content half's own floor), so
 * it is not a constant here; a `max` at or below the floor means there is no
 * room to grow at all, and the floor wins — never a max below the min. */
export function clampFilesTreeWidth(width: number, max: number): number {
  if (!Number.isFinite(width)) return DEFAULT_FILES_TREE_WIDTH
  return Math.max(
    MIN_FILES_TREE_WIDTH,
    Math.min(width, Math.max(MIN_FILES_TREE_WIDTH, max)),
  )
}

/** The stored width, or the default when nothing is stored, the value isn't a
 * finite number, or it is below the floor. A stored value *above* the floor is
 * kept as-is: the live ceiling depends on the current window, which this
 * module can't see, and the caller's clamp pulls it in on mount. */
export function loadFilesTreeWidth(): number {
  const raw = localStorage.getItem(WIDTH_KEY)
  if (raw === null) return DEFAULT_FILES_TREE_WIDTH
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < MIN_FILES_TREE_WIDTH) {
    return DEFAULT_FILES_TREE_WIDTH
  }
  return parsed
}

export function saveFilesTreeWidth(width: number): void {
  localStorage.setItem(WIDTH_KEY, String(width))
}

/** Double-clicking the handle resets to the default — which means forgetting
 * the stored value, not storing 304: a later change to the default should then
 * be picked up rather than pinned by a leftover key (the nav's rule). */
export function clearFilesTreeWidth(): void {
  localStorage.removeItem(WIDTH_KEY)
}

/** Whether the tree is collapsed to its rail. Anything other than the exact
 * stored `true` — nothing stored, a hand-edited value, an older shape — reads
 * as "expanded", the state that can always be recovered from. */
export function loadFilesTreeCollapsed(): boolean {
  return localStorage.getItem(COLLAPSED_KEY) === 'true'
}

export function saveFilesTreeCollapsed(collapsed: boolean): void {
  localStorage.setItem(COLLAPSED_KEY, String(collapsed))
}
