# Mobile (phone form factor)

How the web UI behaves below tablet width. Frontend-only — no CLI, API, or
Rust surface. Two width tiers, both in `frontend/src/App.css`, deliberately
kept at the **end** of that file so they override the desktop rules above at
equal specificity:

| Tier | Query | Meaning |
|---|---|---|
| narrow | `@media (max-width: 860px)` | tablet / split-screen; layout thins, nav unchanged |
| phone | `@media (max-width: 600px)` | the drawer + single-column tier |

`isPhone()` in `Sidebar.tsx` (`matchMedia('(max-width: 600px)')`) is the one
JS mirror of the phone tier. Anything new that needs the phone tier should
prefer a CSS rule over a second JS media query — see *The scrim* below for the
pattern.

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
drawers `1200` → modal backdrop `1250` → command palette `1300`. A modal
therefore still opens above an open drawer.

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
| Board (kanban) | single column; touch-scroll + long-press drag both work |
| Sidebars | overlay drawers with scrim + tap-to-dismiss |
| Git tab | `.git-layout` stacks; diff pane keeps a viewport-bound box |
| CC Dashboard | grids collapse to 1 column; wide tables scroll inside `.cc-panel` |
| History rows | wrap instead of holding fixed timestamp/actor columns |
| Task detail modal | still a centred `min(64rem, 92vw)` box — **not** adapted |
| Files tab | **no phone rules** |
| Storyboard canvas | **no phone rules**; `.frame-header` blocks touch scroll |
| Terminal / Agent panes | **no phone rules**; no on-screen-keyboard handling |
| Inbox / project pages | inherit the shell only; unaudited |

## Planned: phone-first navigation

The tiers above make the desktop layout *survive* a phone. They do not make it
a phone UI: the two collapsed sidebar rails still consume horizontal space on
a 390px screen purely to host their re-expand handles, and every destination
is behind a drawer.

The agreed direction is a **bottom tab bar** at the phone tier, replacing both
rails:

```
┌──────────────────────┐
│  Project Alpha       │  slim header
├──────────────────────┤
│  [ card ]            │
│  [ card ]            │  main — full width, no rails
│  [ card ]            │
├──────────────────────┤
│ Board  Inbox  Agents │  fixed tab bar
│                  ⋯   │
└──────────────────────┘
```

- Four slots: **Board** (active project, else Projects), **Inbox** (carries
  the existing unassigned badge), **Agents** (opens the right drawer), **More**
  (opens the left drawer — CC Dashboard + subnav, Terminal, project list,
  archived group).
- The bar is fixed with `padding-bottom: env(safe-area-inset-bottom)` so iOS's
  home indicator does not sit on the tap targets.
- At the phone tier the collapsed `.sidebar` / `.agent-sidebar` rails are
  hidden; the tab bar is the only way to reach the drawers, so the drawers keep
  their scrim and self-close behavior unchanged.

**The constraint that governs the implementation:** `AgentSidebar` and the
Terminal page are permanent sibling mounts in `App.tsx` and must never
unmount — they own live PTY sessions through `PtyPool`. The existing
`.main-slot-pane` visibility toggle is the established pattern. A tab bar that
conditionally renders its panes would kill every attached terminal on tab
switch; it must toggle visibility, exactly as `terminalActive` already does.

## Verifying a phone change

Drive a real browser at a phone viewport (390×844 is the reference size) —
`@media` rules and touch gestures are not observable from a test suite or a
`curl`. Use a throwaway `MESA_DB` and a non-default port; never QA against a
live server holding real data.

Three checks worth re-running after any change to this surface:

1. Open a drawer → the scrim paints, tapping it closes the drawer, and a drag
   outside the drawer does not scroll the content behind it.
2. A vertical swipe starting **on** a kanban card scrolls the board; a
   long-press on the same card still starts a drag.
3. The shell fills the visible viewport with the browser toolbar both shown and
   hidden — no clipped footer, no second scrollbar.
