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
export const isPhone = () => window.matchMedia('(max-width: 600px)').matches
