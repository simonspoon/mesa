# Mobile (phone form factor)

How the web UI behaves below tablet width. Frontend-only — no CLI, API, or
Rust surface. Two width tiers, both in `frontend/src/App.css`, deliberately
kept at the **end** of that file so they override the desktop rules above at
equal specificity:

| Tier | Query | Meaning |
|---|---|---|
| narrow | `@media (max-width: 860px)` | tablet / split-screen; layout thins, nav unchanged |
| phone | `@media (max-width: 600px)` | the drawer + single-column tier |

One further block sits after those two and is **not** a width tier:
`@media (hover: none) and (pointer: coarse)`, for the single rule whose
trigger is the absence of hover rather than a narrow screen (see *The canvas
gesture model*). Reach for it only when that distinction is real — width is
the default.

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
constraint.

**Scope, and the one place it does not apply.** The rule is about draggables
inside a *scrolling* view. `.frame-header` on the storyboard canvas keeps
`touch-action: none` and is correct to — a pan/zoom canvas is the other case
entirely, and copying the kanban's `pan-y` there would break it. See *The
canvas gesture model* below.

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

## The canvas gesture model

The storyboard is the one phone surface that is **not** a scrolling list, so
invariant 1 inverts on it. It is a pan/zoom canvas (React Flow / `@xyflow`
v12, `StoryboardCanvas.tsx`), and a canvas has to own every touch that lands
inside it — a browser that "helpfully" panned the page mid-pinch would make
it unusable. React Flow says so itself: its own stylesheet puts
`touch-action: none` on `.react-flow__pane` **and** `.react-flow__node`.
`.frame-header` matching that is the canvas agreeing with its library, not
the kanban bug surviving in a second place.

Inside `.storyboard-viewport`, measured at 390×844:

| Gesture | Owner | Measured |
|---|---|---|
| one finger on the background | canvas pans | viewport transform `0` → `-230px` |
| two fingers | canvas zooms | `scale(1)` → `scale(2.13)` |
| one finger on `.frame-header` | that frame moves | node `translate(84,124)` → `(108,188)` |
| one finger on a frame's **body** | nothing | node unmoved, page unmoved |
| tap / double-tap a card | select / edit | — |

`main.scrollTop` stayed `0` through every one of those. It is not zero because
nothing tried: the same swipe dispatched on the page *above* the canvas
scrolls it `0 → 219`.

Two consequences worth stating, because both are choices rather than
accidents:

- **The card body is deliberately inert to drag.** It holds markdown, links
  and inline editors, so it is not a drag handle on desktop either; the phone
  keeps that split rather than inventing a second one. Pan from the
  background, move from the header.
- **The page can only be scrolled by the strips around the canvas box**, since
  the box itself absorbs everything. So the box may never grow tall enough to
  leave no strip — `.storyboard:not(.expanded) .storyboard-viewport` carries a
  `max-height` guard for that. At 390×844 the box is 556px against a 652px
  ceiling, i.e. the guard is currently slack; it exists so a future
  `--tab-viewport-height` change cannot strand the reader. Scrolled to the
  bottom the whole canvas sits on screen (top 231, bottom 787, tab bar at 796).

### The hazard this tier actually has: invisible hit targets

Not `touch-action` — a canvas that owns its gestures is only as good as the
agreement between what is hittable and what is visible, and hover is what
desktop uses to keep those in sync. With no hover, anything
`pointer-events: all` and invisible becomes a trap that swallows the pan with
nothing on screen to explain the refusal. Two were found and fixed:

- **Connection handles.** `.storyboard .react-flow__handle` is `opacity: 0`
  until its node is hovered, but stays hit-testable — 22×22, four per frame,
  28 on the test board with six of them on screen at rest. They are now shown
  (`opacity: 0.55`) on coarse pointers, which also makes touch edge-creation
  possible at all.
- **The control cluster's bounding box.** `.react-flow__panel` sets no
  `pointer-events`, so the gaps *between* the buttons ate the gesture across
  the canvas's whole top-left corner. The panel is now `pointer-events: none`
  with its buttons `auto`.

The handle fix lives in a third, **capability-scoped** block at the end of
`App.css` — `@media (hover: none) and (pointer: coarse)`, the only one in the
file. That is deliberate: the defect tracks the absence of hover, not the
width. A 900px touch tablet has it; a 500px desktop window does not, and
neither width tier could say so. Verified both ways — under touch emulation
the query matches and the handles read `0.55`; in a plain 390px desktop
window it does not match and they stay `0`.

### Sizing

Touch targets at the phone tier, all measured after the change:

| Control | Before | After |
|---|---|---|
| React Flow zoom buttons | 26×26 | 44×44 |
| add frame / auto layout / direction | 128×26 | ~110×44, wrapped into a row |
| expand | 87×26 | 87×44 |
| `.frame-header` (the drag handle) | 238×28 | 238×44 |
| edge label ✕ | 19×18 | 28×28 |

The edge chips stop at 28px on purpose. They float over the graph rather than
over chrome, and a 44px chip on a 390px-wide canvas hides the connector it
annotates — the 44px floor applies to the controls, not to annotations.

Two layout changes follow from the same budget. The MiniMap is `display: none`
here: 200×150 is a sixth of a 366×556 canvas, parked over the corner, and it
blocks panning there. And the control cluster becomes a wrapping **row** — as
a column of 44px rows it measured ~500px of a 556px canvas, i.e. the controls
covering the drawing; as a row it is 260×128, 23% of the canvas height.

The canvas hint is rendered twice, `.canvas-hint` and `.canvas-hint-touch`,
swapped by CSS at this tier — the desktop copy names mouse gestures
("double-click", "drag a side dot") that do not exist here, so the difference
is the gesture model itself, not the wording. Two spans and a `display` swap,
rather than a second `isPhone()` call.

### Known gaps

- **Waypoint handles and anchor-lock dots are unreachable by touch.** Both are
  10px and both are rendered only while their edge is hovered (`FrameEdgeView`
  keeps that in React state), so on a phone they are never in the DOM at all —
  confirmed, not assumed: `.anchor-lock-halo`, `.anchor-lock-dot` and
  `.waypoint-handle` all query to `0` at rest. Edge re-routing and anchor
  locking are therefore desktop-only for now. Enlarging them would not help;
  they need a touch-reachable way to be *revealed* first.
- Frame resize has no touch affordance either, for the same reason.

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
| Storyboard canvas | pan/zoom/move all work by touch; controls at 44px, MiniMap hidden — see *The canvas gesture model* |
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

A wheel event cannot stand in for a swipe: `touch-action` governs touch
panning only, so a mouse-driven check reports on the presence of an
intercepting element and nothing about the gesture. The driver needs real
`Input.dispatchTouchEvent` — khora gained `swipe`/`touch`/`long-press` and
`emulate-touch` after 0.3.17. On an older build, talk to the session's CDP
port directly (multi-finger pinch needs that anyway, since `swipe` is one
contact); do the emulation, the gesture and the read-back on **one**
connection, because Chrome drops both the touch-emulation and
device-metrics overrides when a client disconnects.

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
5. Open a storyboard: one finger on the canvas background pans it, two
   fingers zoom, a drag on a frame header moves that frame, and
   `main.scrollTop` stays put through all three. Quote the transform values —
   "the canvas panned" is not a number.
6. Open a task detail: the sheet fills the viewport, its body scrolls while
   the board behind holds its scroll position, the ✕ stays pinned at the top,
   and pressing `a` while it is open does **not** open the create-task modal.
   Scroll the board first, so "returns to the same position" is a claim with
   a non-zero number in it.
