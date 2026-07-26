# Mobile (phone form factor)

How the web UI behaves below tablet width. Frontend-only — no CLI, API, or
Rust surface. Two width tiers, both in `frontend/src/App.css`, deliberately
kept at the **end** of that file so they override the desktop rules above at
equal specificity:

| Tier | Query | Meaning |
|---|---|---|
| narrow | `@media (max-width: 860px)` | tablet / split-screen; layout thins, nav unchanged |
| phone | `@media (max-width: 600px)` | the drawer + single-column tier |

`isPhone()` in `frontend/src/phoneTier.ts` (`matchMedia('(max-width: 600px)')`)
is the one JS mirror of the phone tier. Anything new that needs the phone tier
should prefer a CSS rule over a second JS media query — see *The scrim* below
for the pattern; both `.drawer-scrim` and `.phone-tabbar` are rendered
unconditionally and switched on by CSS alone.

## The three phone invariants

These are load-bearing. Each was a reported bug before it was a rule.

### 1. Touch drag activates on **delay**, never distance

`KanbanBoard.tsx` uses `MouseSensor` + `TouchSensor`, not the single
`PointerSensor` that covers both, precisely so the two input types get
different activation gestures:

```ts
useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
```

Why it must be `delay` on touch: dnd-kit's `AbstractPointerSensor.handleMove`
returns **before** its `event.preventDefault()` for as long as activation is
still pending, and cancels the pending drag outright once the finger passes
`tolerance`. So under a delay constraint a swipe scrolls natively and only a
stationary press becomes a drag. Under a `distance` constraint the drag
activates at 5px — i.e. instantly, on any swipe — which is why the card
previously had to carry `touch-action: none` to stop the browser panning
first.

That `touch-action: none` was the actual defect: at phone width the kanban is
`grid-template-columns: 1fr`, a single column that is almost entirely cards,
so the board could not be scrolled by touch anywhere it mattered.
`.kanban-card` is now `touch-action: pan-y`.

**The rule:** a draggable that fills a scrollable phone view may not set
`touch-action: none`. Give it `pan-y` and move its sensor to a delay
constraint. `.frame-header` (the storyboard canvas) still has the old
combination and is the known remaining instance.

### 2. An overlay drawer owns the whole viewport, via a scrim

At phone width both sidebars stop being columns and become `position: fixed`
overlay drawers (`z-index: 1200`):

- `.sidebar:not(.collapsed)` — left, `min(16rem, 85vw)`. Starts collapsed on
  phones and closes itself on `hashchange` (`Sidebar.tsx`).
- `.agent-sidebar:not(.collapsed)` — right, `min(24rem, 90vw)`. Already
  defaults to collapsed.

Each renders a **`.drawer-scrim`** sibling while expanded — `display: none`
by default, `display: block` inside the phone tier, so there is no second JS
media query to keep in sync. It sits at `z-index: 1150`: under the drawers,
over the page.

It carries `touch-action: none`, and that is the point. Without a scrim, a
touch landing in the drawer's exposed margin hit `main` directly and scrolled
the page *behind* the open drawer. `overscroll-behavior` does not help here —
the page behind was never the drawer's scroll chain, it was simply the element
under the finger. The scrim also gives the drawer a tap-to-dismiss target,
which it previously lacked entirely.

`z-index` ladder, lowest first: storyboard takeover `1000` → scrim `1150` →
drawers `1200` → **tab bar `1220`** → modal backdrop `1250` → command palette
`1300`. A modal therefore still opens above an open drawer, and the tab bar
stays tappable while a drawer is open (see *Bottom tab bar* below).

### 3. The shell is bound to `dvh`, not `vh`

`#root` is the viewport lock (`height`, `overflow: hidden`) and `main` is the
only scroll container — a deliberate structure, so that a wheel over a sticky
sidebar has no document scroll to chain into. On a phone that makes the unit
choice load-bearing: a `100vh` that overshoots the visible area by the height
of the browser's dynamic toolbar pushes the bottom of `main` under that
toolbar with nothing left to scroll to reach it.

`index.css` therefore sets `#root { height: 100dvh }` inside
`@supports (height: 100dvh)`, alongside the `--tab-viewport-height` override
that already lived there.

## Current per-surface state

| Surface | Phone state |
|---|---|
| Bottom nav | four-slot tab bar; the only nav chrome on a phone |
| Board (kanban) | single column; touch-scroll + long-press drag both work |
| Sidebars | overlay drawers with scrim + tap-to-dismiss; rails hidden, opened from the tab bar |
| Git tab | `.git-layout` stacks; diff pane keeps a viewport-bound box |
| CC Dashboard | grids collapse to 1 column; wide tables scroll inside `.cc-panel` |
| History rows | wrap instead of holding fixed timestamp/actor columns |
| Modals (task detail, new task, new project) | full-screen sheets with a sticky close header |
| Files tab | **no phone rules** |
| Storyboard canvas | **no phone rules**; `.frame-header` blocks touch scroll |
| Terminal / Agent panes | **no phone rules**; no on-screen-keyboard handling |
| Inbox / project pages | inherit the shell only; unaudited |

## Bottom tab bar

The tiers above make the desktop layout *survive* a phone. They did not make
it a phone UI: the two collapsed sidebar rails consumed horizontal space on a
390px screen purely to host their re-expand handles, and every destination sat
behind a drawer.

`PhoneTabBar.tsx` replaces both rails with a fixed four-slot bar:

```
┌──────────────────────┐
│  Project Alpha       │  slim header
├──────────────────────┤
│  [ card ]            │
│  [ card ]            │  main — full width, no rails
│  [ card ]            │
├──────────────────────┤
│ Board Inbox Agents ⋯ │  fixed tab bar (⋯ = More)
└──────────────────────┘
```

- Four slots: **Board** (the active project; with no active project the slot
  reads *Projects* and opens the left drawer, since there is no `#/projects`
  index route), **Inbox** (carries the unassigned badge), **Agents** (opens
  the right drawer), **More** (opens the left drawer — CC Dashboard + subnav,
  Terminal, project list, archived group).
- The bar is fixed with `padding-bottom: env(safe-area-inset-bottom)` so iOS's
  home indicator does not sit on the tap targets. `--phone-tabbar-reserve`
  (bar height + that inset) is what `main`, `.terminal-page` and both drawers
  keep clear.
- The collapsed rails are gone at this tier, but by two *different* mechanisms,
  and the difference is load-bearing. `.sidebar.collapsed` holds nothing but
  its handle, so it is `display: none`. `.agent-sidebar.collapsed` may not be:
  its body is deliberately `visibility: hidden` rather than `display: none` so
  an attached terminal's fitted layout box survives a collapse/expand cycle
  with no refit. It is clipped to `width: 0` instead — the same mechanism as
  its usual 2.5rem collapse, with no rail left over.
- The bar sits *above* the drawers in the `z-index` ladder, so switching tabs
  while a drawer is open is one tap rather than dismiss-then-tap. The drawers
  otherwise keep their scrim and self-close behavior unchanged.
- Both sidebars' `collapsed` state moved to `App.tsx`, since the bar is now a
  third party driving what were two private booleans. Slots that navigate also
  close both drawers explicitly: the left drawer's self-close listens for
  `hashchange`, which does not fire when you tap the project you are already
  on, and the right drawer never self-closed on navigation at all.
- One inbox poll lives in `App.tsx` and feeds both badges. `useFetch` caches
  nothing across components, so an identical `key` in each would still be two
  requests and the two counts could skew by a poll interval.

**The constraint that governs the implementation:** `AgentSidebar` and the
Terminal page are permanent sibling mounts in `App.tsx` and must never
unmount — they own live PTY sessions through `PtyPool`. The existing
`.main-slot-pane` visibility toggle is the established pattern. A tab bar that
conditionally rendered its panes would kill every attached terminal on tab
switch; it toggles visibility only, exactly as `terminalActive` already does.

## Full-screen modal sheets

All three modals share one backdrop (`.create-task-backdrop`) and two box
classes: `.task-modal` (task detail, `min(64rem, 92vw)`) and
`.create-task-modal` (new task *and* new project, `min(26rem, 90vw)`). At the
phone tier the backdrop stops centring its child and the box fills the
viewport instead — full width and height, no `--cut` corner notch, no border
or glow, body scrolling inside itself.

Three things about that are load-bearing rather than cosmetic:

- **A full-bleed sheet is what makes the touch story work**, and it needs no
  scrim to do it. Invariant 2 above exists because an overlay that leaves
  backdrop margin exposed lets a touch land on `main` and scroll the page
  behind it. A sheet at `inset: 0` has no exposed margin, so every touch is
  already the sheet's. What remains is *chaining* — a scroll that reaches the
  sheet's end continuing into the page — and `overscroll-behavior: contain`
  on the box covers that. There is deliberately no body-scroll lock: the board
  keeps its scroll position for free, which is what closing the sheet has to
  return to.
- **The class names and the z-index are contracts, not styling.**
  `shouldIgnoreShortcut()` (`keyboardScope.ts`) matches
  `.create-task-backdrop` in the DOM to suppress global single-key shortcuts
  while a modal is open (`docs/keyboard.md`) — a phone-tier rename would
  silently re-arm `a` behind an open sheet. `z-index: 1250` is what keeps the
  sheet above the drawers (1200) and the tab bar (1220); the sheet covers the
  bar rather than sitting above it, so it clears `env(safe-area-inset-bottom)`
  directly instead of `--phone-tabbar-reserve`.
- **The close affordance is pinned.** Every panel inside these boxes
  (`TaskPanel`, `CreateTaskPanel`, `CreateProjectPanel`) already renders a
  `.panel-head` with a ✕ as its first child. Centred, it was always on screen
  and the backdrop was a second way out; full-screen, both of those go away —
  a long task detail scrolls the ✕ off the top and there is no backdrop left
  to tap. `.panel-head` is therefore `position: sticky` at the phone tier,
  with negative horizontal margins so the bar spans the sheet's padding.

## Verifying a phone change

Drive a real browser at a phone viewport (390×844 is the reference size) —
`@media` rules and touch gestures are not observable from a test suite or a
`curl`. Use a throwaway `MESA_DB` and a non-default port; never QA against a
live server holding real data.

Checks worth re-running after any change to this surface:

1. Open a drawer → the scrim paints, tapping it closes the drawer, and a drag
   outside the drawer does not scroll the content behind it.
2. A vertical swipe starting **on** a kanban card scrolls the board; a
   long-press on the same card still starts a drag.
3. The shell fills the visible viewport with the browser toolbar both shown and
   hidden — no clipped footer, no second scrollbar.
4. Attach a terminal in the Agents drawer, tab away, tab back: it is still
   attached and still scrolled where it was. This is the one check a tab-bar
   change can silently break, and it fails loudly only in a *live* browser —
   nothing about the JSX makes a conditional render look wrong.
5. Open a task detail: the sheet fills the viewport, its body scrolls while
   the board behind holds its scroll position, the ✕ stays pinned at the top,
   and pressing `a` while it is open does **not** open the create-task modal.
   Scroll the board first, so "returns to the same position" is a claim with
   a non-zero number in it.
