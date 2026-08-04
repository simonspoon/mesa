// Width of the agent sidebar (mesa task 685) — the mirror of `navWidth.ts`,
// minus the persistence: this width is *not* stored, so every load starts at
// the default and the only clamped inputs are a mid-drag pointer position and
// the live layout. The clamp still belongs here rather than in the component,
// for the same reason it does there: it is a rule about what the shell can
// render, exercised by unit tests, not a detail of one drag handler.
//
// The default is sized off what the sidebar has to *hold*, not off what looks
// tidy collapsed. With the 'Agents' list rail expanded (the default) the tile
// area gets `width - 32 (body padding) - 8 (gap) - 240 (rail)`, and that box
// is where a Claude Code session renders: below ~80 columns its boxes, diffs
// and tool output all wrap into noise. Measured at the desktop
// `--pty-font-size` (13px, ~7px per cell), 80 columns needs ~560px of tile
// area — hence the number below. Affordable only because the sidebar starts
// collapsed; the clamp is what keeps it honest on a small window.

/** Matches the `width: var(--agent-sidebar-width, 55rem)` fallback in App.css
 * (two sites). All three numbers must move together — the CSS value is what a
 * first paint uses, before React sets the inline custom property. */
export const DEFAULT_AGENT_SIDEBAR_WIDTH = 880

/** Narrower than this and the sidebar's own header controls start colliding;
 * the collapse toggle, not the drag, is how you get smaller than that. */
export const MIN_AGENT_SIDEBAR_WIDTH = 280

/** `main`'s floor, the other half of the same clamp: without it, dragging (or
 * now, defaulting) the sidebar wide squeezes main's content — the CC
 * Dashboard's cards, etc. — into character-by-character wrapping rather than
 * a clean overflow the browser would catch. */
export const MIN_MAIN_WIDTH = 320

/** Clamp a candidate width into range. `max` is measured live off the layout
 * by the caller (the viewport minus main's left edge minus `MIN_MAIN_WIDTH`),
 * so it is not a constant here; a `max` at or below the floor means there is
 * no room at all, and the floor wins — never a max below the min. */
export function clampAgentSidebarWidth(width: number, max: number): number {
  if (!Number.isFinite(width)) return DEFAULT_AGENT_SIDEBAR_WIDTH
  return Math.max(
    MIN_AGENT_SIDEBAR_WIDTH,
    Math.min(width, Math.max(MIN_AGENT_SIDEBAR_WIDTH, max)),
  )
}
