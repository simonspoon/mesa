// Persisted width of the left nav sidebar (mesa task 665), the mirror of the
// agent sidebar's own drag-resize. Machine-local (localStorage), like
// `lastFolder.ts` and the diagram view state: it is a per-browser
// preference about this one screen, never project or server data, so it has
// no column, no route and no place in a backup.
//
// The clamp lives here rather than in the component because a stored value is
// as untrusted as a mid-drag pointer position — a hand-edited key, a value
// written on a 2560px monitor and reloaded on a 1280px laptop, or a stale
// entry from before the floor changed all have to resolve to something the
// shell can render. Every path out of this module (load and clamp alike)
// returns a number in range or the default; the component never holds an
// out-of-range width, it doesn't merely render one.

const KEY = 'mesa-nav-width'

/** Matches the `width: var(--nav-width, 220px)` fallback in App.css. Both
 * numbers must move together — the CSS value is what a first visit (nothing
 * stored, no inline custom property yet) paints. */
export const DEFAULT_NAV_WIDTH = 220

/** Narrower than this and the nav's own entries start clipping; the collapse
 * toggle, not the drag, is how you get smaller than a usable nav. */
export const MIN_NAV_WIDTH = 160

/** Clamp a candidate width into range. `max` is measured live off the layout
 * by the caller (main's right edge minus its own floor), so it is not a
 * constant here; a `max` at or below the floor means there is no room to
 * grow at all, and the floor wins — never a max below the min. */
export function clampNavWidth(width: number, max: number): number {
  if (!Number.isFinite(width)) return DEFAULT_NAV_WIDTH
  return Math.max(MIN_NAV_WIDTH, Math.min(width, Math.max(MIN_NAV_WIDTH, max)))
}

/** The stored width, or the default when nothing is stored, the value isn't a
 * finite number, or it is below the floor. A stored value *above* the floor is
 * kept as-is: the live ceiling depends on the current window, which this
 * module can't see, and the drag's own clamp will pull it in on first use. */
export function loadNavWidth(): number {
  const raw = localStorage.getItem(KEY)
  if (raw === null) return DEFAULT_NAV_WIDTH
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < MIN_NAV_WIDTH) return DEFAULT_NAV_WIDTH
  return parsed
}

export function saveNavWidth(width: number): void {
  localStorage.setItem(KEY, String(width))
}

/** Double-clicking the handle resets to the default — which means forgetting
 * the stored value, not storing 220: a later change to the default should
 * then be picked up rather than pinned by a leftover key. */
export function clearNavWidth(): void {
  localStorage.removeItem(KEY)
}
