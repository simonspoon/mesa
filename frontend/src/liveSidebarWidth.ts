// Persisted width of the live conversation panel (mesa task 1144) — modelled
// on `liveBoardWidth.ts`, and sharing its one departure from the nav's and
// the file tree's rule: "nothing chosen" is `null`, not a number.
//
// The panel's default width is a CSS *expression* — `min(26rem, 40vw)` in
// App.css — a rule rather than a length, so no single number this module
// could return would be right on both a laptop and a 3440px monitor. An unset
// width is `null`, `LiveHub` sets no inline `--live-sidebar-width` at all, and
// the stylesheet's own value stands. A number here always means the person
// dragged the panel's edge.
//
// The clamp lives here rather than in `LiveHub` because a stored value is as
// untrusted as a mid-drag pointer position. The ceiling is measured live off
// the layout by the caller — the room between `main`'s left edge and the
// panel's own right edge, less `main`'s floor — so it is an argument rather
// than a constant. The phone tier never reaches this module: there the panel
// is a fixed drawer whose width App.css sets directly, not through the custom
// property, so a stored width does not apply.

const WIDTH_KEY = 'mesa-live-sidebar-width'

/** Nothing stored: let App.css's `min(26rem, 40vw)` decide, since it decides
 * differently per window and this module cannot see one. */
export const DEFAULT_LIVE_SIDEBAR_WIDTH = null

/** Narrower than this and the transcript is a column of single words and the
 * capture box a slit. Closing the panel, not the drag, is how you get less
 * than a readable conversation. */
export const MIN_LIVE_SIDEBAR_WIDTH = 240

/** Clamp a candidate width into range. `max` is measured live off the layout
 * by the caller, so it is not a constant here; a `max` at or below the floor
 * means the window has no room to give, and the floor wins — never a max
 * below the min.
 *
 * A non-finite width answers the floor rather than a default, because there is
 * no numeric default to fall back to: `null` means "the stylesheet decides",
 * and this function's contract is a number. */
export function clampLiveSidebarWidth(width: number, max: number): number {
  const ceiling = Math.max(MIN_LIVE_SIDEBAR_WIDTH, max)
  if (!Number.isFinite(width)) return MIN_LIVE_SIDEBAR_WIDTH
  return Math.max(MIN_LIVE_SIDEBAR_WIDTH, Math.min(width, ceiling))
}

/** The stored width, or `null` when nothing is stored, the value isn't a
 * finite number, or it is below the floor — all three being "this browser has
 * no opinion", which is what the CSS default is for. A stored value *above*
 * the floor is returned as-is: the live ceiling depends on the current window,
 * which this module can't see, and the next drag pulls it in. */
export function loadLiveSidebarWidth(): number | null {
  const raw = localStorage.getItem(WIDTH_KEY)
  if (raw === null) return DEFAULT_LIVE_SIDEBAR_WIDTH
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < MIN_LIVE_SIDEBAR_WIDTH) {
    return DEFAULT_LIVE_SIDEBAR_WIDTH
  }
  return parsed
}

export function saveLiveSidebarWidth(width: number): void {
  localStorage.setItem(WIDTH_KEY, String(width))
}

/** Double-clicking the handle goes back to the default — which means
 * forgetting the stored value, not storing a number: the default is a CSS
 * expression that answers differently per window, and a number pinned here
 * would stop it doing that. */
export function clearLiveSidebarWidth(): void {
  localStorage.removeItem(WIDTH_KEY)
}
