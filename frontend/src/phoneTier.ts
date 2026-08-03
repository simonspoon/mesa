import { useSyncExternalStore } from 'react'

/**
 * The one JS mirror of the phone tier — everything else about that breakpoint
 * lives in the `@media (max-width: 600px)` block at the end of `App.css`, and
 * anything new that needs it should prefer a CSS rule to a second query here
 * (see `.drawer-scrim` / `.phone-tabbar`, which are rendered unconditionally
 * and switched on by CSS alone).
 *
 * Keep this value in step with that media query.
 *
 * It has its own module rather than living in `Sidebar.tsx` because `App.tsx`
 * needs it too, now that App owns both sidebars' collapse state for the phone
 * tab bar (mesa task 556) — and a non-component export from a component file
 * trips `react-refresh/only-export-components`.
 */
const PHONE_QUERY = '(max-width: 600px)'

/**
 * The *narrow* tier (`docs/mobile.md`'s other width tier) — tablet and
 * split-screen widths, where `.files-layout` and `.git-layout` already stack
 * into a column.
 *
 * It lives here for the same reason the phone query does, and under the same
 * rule: this module is the one place a width breakpoint may be mirrored into
 * JS, and there is exactly one `MediaQueryList` **per tier**, never a second
 * for the same one. Prefer a CSS rule to either.
 *
 * Its one JS consumer is the Files tab's split (mesa task 670): two side-by-
 * side content panes are not survivable below 860px, and the split is a React
 * data structure — a CSS rule could only hide the second pane, leaving state
 * whose meaning no longer matches what is on screen. Same argument
 * `usePhoneTier()` makes for the terminal's pane tree, one tier up.
 */
const NARROW_QUERY = '(max-width: 860px)'

// One `MediaQueryList` per tier for the whole app, so "the one JS mirror"
// stays literally one: `isPhone()` and `usePhoneTier()` below read the same
// object, and a second `matchMedia(...)` call anywhere else is the thing this
// module exists to prevent.
const mql = window.matchMedia(PHONE_QUERY)
const narrowMql = window.matchMedia(NARROW_QUERY)

export const isPhone = () => mql.matches

function subscribe(cb: () => void): () => void {
  mql.addEventListener('change', cb)
  return () => mql.removeEventListener('change', cb)
}

/**
 * Subscribe to *crossings* of the phone breakpoint, for state whose meaning
 * differs either side of it rather than merely its styling (mesa task 562:
 * both sidebars' `collapsed` flag, which is an in-flow sidebar above 600px
 * and a fixed overlay drawer below).
 *
 * Edge-triggered by construction — `change` fires only when `matches` flips —
 * which is the point: a caller adjusting a tier-dependent *default* must not
 * re-assert it on every render, or it overrides the user's own toggle. That
 * also keeps the setState in a subscription callback rather than an effect
 * body, which is what `react-hooks/set-state-in-effect` asks for.
 *
 * Distinct from `usePhoneTier()` above, which reports the current *value* for
 * components that render differently per tier. Same one `MediaQueryList`.
 */
export function onPhoneTierChange(
  cb: (phone: boolean) => void,
): () => void {
  const handler = (e: MediaQueryListEvent) => cb(e.matches)
  mql.addEventListener('change', handler)
  return () => mql.removeEventListener('change', handler)
}

/**
 * Reactive form of `isPhone()`, for the one case CSS genuinely cannot cover
 * (mesa task 560): the PTY surfaces collapse their pane *tree* to a single
 * pane at this tier, and a tree is a JS data structure — a CSS rule can only
 * hide the extra panes, which is strictly worse than not rendering them.
 * `display: none` on a live pane collapses the box `FitAddon` measures to
 * zero (the trap `docs/terminal.md` already names for the cross-nav
 * `visibility` toggle), and a hidden-but-connected shell is a process the
 * user can neither see nor reach.
 *
 * Everything that *can* be a plain media-query rule still should be — this is
 * an exception with a reason, not a new default.
 */
export function usePhoneTier(): boolean {
  return useSyncExternalStore(subscribe, isPhone, () => false)
}

export const isNarrow = () => narrowMql.matches

/**
 * `onPhoneTierChange()`'s twin for the narrow tier, and edge-triggered for the
 * same reason: the Files tab's split is tier-dependent *state*, so it must be
 * folded on the crossing rather than re-derived on every render — deriving it
 * would re-collapse a split the user re-opened at, say, 800px.
 */
export function onNarrowTierChange(cb: (narrow: boolean) => void): () => void {
  const handler = (e: MediaQueryListEvent) => cb(e.matches)
  narrowMql.addEventListener('change', handler)
  return () => narrowMql.removeEventListener('change', handler)
}

/** Reactive form of `isNarrow()`, for the same narrow exception: the Files
 *  tab renders one pane and hides the Split control below 860px. */
export function useNarrowTier(): boolean {
  return useSyncExternalStore(
    (cb) => {
      narrowMql.addEventListener('change', cb)
      return () => narrowMql.removeEventListener('change', cb)
    },
    isNarrow,
    () => false,
  )
}
