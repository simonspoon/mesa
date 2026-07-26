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
| CC Dashboard | grids collapse to 1 column; wide tables scroll inside `.cc-table-wrap` behind a frozen identity column — see *CC Dashboard tables* |
| History rows | wrap instead of holding fixed timestamp/actor columns |
| Modals (task detail, new task, new project) | full-screen sheets with a sticky close header |
| Files tab | tree collapses when a file opens, behind a breadcrumb toggle; per-file diffs go unified — see *Files tab and the unified diff* |
| Storyboard canvas | pan/zoom/move all work by touch; controls at 44px, MiniMap hidden — see *The canvas gesture model* |
| Terminal / Agent panes | one pane, no split UI; shell height follows the on-screen keyboard — see *Terminal and agent panes* |
| Inbox | body text wraps unbreakable URLs; the assign `<select>` is capped to its row — see *Crossing the breakpoint* for the audit's other half |
| Project page header / tab strip | `.tabs` already wraps to two rows at 390px; all six tabs in-view and hit-testable, no change needed |
| Command palette | 351px wide inside a 390px viewport, input autofocused; no change needed |
| Archived projects group | drawer rows hold at 223px with a 56-char name; `restore` stays visible and hittable |

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

## Files tab and the unified diff

The ≤860px tier had already stacked `.files-layout` into a column since the
Files tab shipped, so this surface was never a two-columns-at-390px problem —
which is what made it look done. The defect was vertical. The tree is a full
column of rows sitting *above* the file, and measured at 390×844 with a file
open, `.files-content-pane`'s top sat at **643px of an 844px viewport**: the
file the tab exists to show was almost entirely below the fold, reachable only
by scrolling `main` past a tree that had already done its job.

So opening a file collapses the tree (`FilesView`'s `treeOpen`), behind a
toggle that doubles as a breadcrumb (`▸ file tree — <path>`). Same measurement
after: content top **287px**, full width. `display: none` rather than a height
cap because on a phone the tree is a *navigation step*, not a persistent
sidebar — once you are reading, a 30vh stub of folders is still a third of the
screen spent on the thing you have finished with.

Two things are worth knowing before touching it:

- **`treeOpen` is inert above 600px, and deliberately so.** The button is
  `display: none` and `.files-tree-collapsed` has no rule outside the phone
  block, so a desktop user who opened a file has the flag set and the tree
  still up. That is the same "the breakpoint lives in CSS alone" rule the tab
  bar follows — no second `matchMedia` for a component to keep in sync — and
  it is what a desktop regression check should assert: `treeCls` containing
  `files-tree-collapsed` while `treeDisplay` reads `block`.
- **Nothing resizes `.files-content-pane` to go with the collapse.** An
  attempt to was measured inert and removed: the pane is `flex: 1 1 0%` in a
  column whose height the ≤860px tier already relaxed to `auto`, so flex-basis
  beats any `height` and the pane sizes to its content. That is what this tier
  wants — a long file grows the pane and scrolls `main` rather than trapping
  the reader in a nested scroller (`Cargo.lock`: 32890px pane, 33286px `main`).

**`SideBySideDiff` goes unified at the phone tier, in CSS alone.** Its two text
tracks measured 150px each at 390px — narrower than the code they quote, so
every line wrapped several times and the alignment two columns buy was worth
nothing. Dropping the grid to two columns converts the *same* markup, because
the cells are emitted flat into one grid with no per-row wrapper: the leftovers
reflow in source order, so a changed row's old half lands on one grid row and
its new half on the next — exactly old-above-new. Two cells have to disappear
for that to read correctly:

- the **right half of a context row** (it is the identical line, printed twice)
- **either half that stands for "nothing here"** on an unpaired add/delete

Both are addressable only because each cell carries its side
(`diff-split-l`/`-r`, added for this) — the tint classes cannot tell a context
row's two halves apart, since both are `diff-split-ctx`. `::before` markers
(`-`/`+`/space) restore the gutter the parser strips, which stops being
decoration once colour is the only other signal and the two lines are stacked
rather than side by side. Measured after: text column 150px → **306px**.

The Git tab is *not* part of this. It renders its own unified `<pre
class="git-diff-text">` (`GitView.tsx`) and never touches `SideBySideDiff`;
verified readable at 390×844 as-is — single column, 250 lines, mono, scrolling
both ways per the same verbatim doctrine as the file viewer. Its file list has
the same push-below-the-fold shape the tree had (diff pane top at 680px), which
is a real but separate gap.

## CC Dashboard tables

Everything the ≤600px tier needed here was already in place before mesa task
561 — the grids collapse at 860px, the charts are `preserveAspectRatio="none"`
SVG that reflow to any width, and no page anywhere overflows 390px
(`documentElement.scrollWidth` measured at 390 on all four routes, before and
after). The KPI grid lands on two 165px columns, the model donut is a fixed
168px inside a 305px panel, the subscription card's bars are block-level and
fit at 340/340. So this was a readability pass, and it found two things.

**The scroll box belongs on the table, not the panel.** `.cc-table` cells are
`white-space: nowrap`, so a table's min-content width is set by its content:
575px (skills), 792px (sessions) inside a 305px content box. The phone tier had
answered that with `overflow-x: auto` on `.cc-panel`, which works — a trusted
swipe scrolls it — but the panel also holds the `<h2>` and the hint line, so
scrolling 234px to reach the token columns took the word "Sessions" with it.
`.cc-table-wrap` (in `DataTable`, at every width) scrolls the table alone.
Desktop benefits too: the Skills table sits in a 497px `.cc-pair` cell at
1440px and used to spill out of its panel.

**A frozen first column is what makes the scroll usable.** Scrolled right, every
row read `opus-5` / `fable-5, opus-5` with nothing naming it. The first column
goes `position: sticky; left: 0` at ≤600px only. Two things that has to carry:

- `border-collapse: separate` (with `border-spacing: 0`, so nothing else
  changes). Under `collapse` the borders live in a table-wide layer that does
  not travel with a sticky cell, and the frozen column loses its row rules.
  The separating rule is a `box-shadow`, not a `border-right`, which would
  widen the cell and shift every column behind it.
- A **pinned** width — `min-width` and `max-width` both `6.5rem`. Automatic
  table layout sizes a column from its content and neither end behaves on its
  own: uncapped, a skill id took 225px of the 340px panel; capped only, a
  timestamp collapsed to 65px and spilled over three lines.

The wrapping mode is `overflow-wrap: break-word`, and `anywhere` is a trap
worth naming: the two differ in whether the break opportunity counts towards
min-content, and this column is sized *from* min-content. Under `anywhere` its
min-content became one character, so the column was handed 1ch and every
timestamp rendered one glyph per line at ~380px a row. Every computed-style
assert (`position: sticky`, `left: 0px`, the pinned `104px`) still reported
correct — only the screenshot showed it.

Separately, `.cc-live-card-top` and `.cc-live-sub` were `flex-wrap: nowrap`
rows of five or six chips; at 278px a session with a subagent badge and two
models pushed its own age off the card. They wrap at this tier.

## Terminal and agent panes

Three surfaces share one component tree — the global Terminal page
(`#/terminal`), the project Terminal tab (`#/projects/:id/terminal`) and the
Agent sidebar's attached panes — and none of them had a phone rule before mesa
task 560. All numbers below were measured at 390×844 against the release
binary.

### The fourth viewport unit

Invariant 3 above says the shell is bound to `dvh`, not `vh`. That is still
true and still necessary, and it is **not sufficient on a terminal**, because
`dvh` tracks the browser's dynamic toolbars and nothing else. An on-screen
keyboard does not resize the layout viewport at all — it shrinks the *visual*
viewport — so a `100dvh` shell keeps believing it is 844px tall while the
bottom 444px of it sits under the keyboard. On a terminal that bottom is the
prompt.

`frontend/src/visualViewport.ts` publishes `window.visualViewport.height` as
`--visual-viewport-height` on `<html>`, at every width; the phone block is the
only place that reads it, via `--phone-shell-height` (which falls back to
`100dvh`, the value it equals whenever no keyboard is up). Three boxes are
sized from it: `#root`, and both overlay drawers — the drawers need it
separately because a `position: fixed` box is laid out against the *layout*
viewport, so `bottom: <reserve>` alone puts an open drawer's floor behind the
keyboard.

Measured, with the visual viewport driven to 400px:

| | before | after |
|---|---|---|
| `#root` height | 844px | 400px |
| terminal screen bottom | 764px | 322px |
| prompt visible above a keyboard at 400 | **no** | yes |
| PTY `{"resize":…}` frames per keyboard open | 0 (nothing reacted) | **1** |
| …per close | 0 | **1** |

The frame count is the number mesa task 552 makes load-bearing: one resize
frame is one SIGWINCH into an attached `claude attach` process, and 89 of them
is the bug that task fixed. One per keyboard transition, per live PTY, is the
bounded result — verified by hooking `WebSocket.prototype.send` and counting,
not by assuming. A drawer with an agent attached alongside the always-mounted
Terminal page emits 2 frames per transition, which is 1 each, not a storm.

Updates are coalesced into one `requestAnimationFrame` per burst, because iOS
emits a stream of `resize` events through the keyboard's slide-in animation
and each one would otherwise refit every open xterm.

**Deliberately not handled: `visualViewport.offsetTop`.** A browser that
scrolls the layout viewport to keep a focused input above the keyboard reports
it there, and a matching translate is the usual companion fix. It is absent
because it could not be verified — the rig for this change drives Chrome with
a synthetic `visualViewport` resize, which reproduces the height change exactly
and the scroll-to-focus behaviour not at all. Shipping it would have been an
unmeasured claim, not a fix.

### One pane, and why it is JS

A 390px screen has no room for a split: two side-by-side xterms are ~23
columns each, and every affordance the split UI has — divider drag, pane grip,
drop zones — is a pointer gesture with no touch equivalent. So both PTY
surfaces render exactly one pane here (`SoloShellPane` / `SoloAgentPane`,
deliberate siblings of the sortable versions since `useSortable` requires a
`DndContext` and the point is that there isn't one), and the Terminal page
hides `+ new shell`, the only control that can mint a second.

This is the one place the "prefer a CSS rule, keep the breakpoint out of JS"
rule is broken on purpose, and `usePhoneTier()` in `phoneTier.ts` — a
`useSyncExternalStore` over the *same* `MediaQueryList` `isPhone()` already
uses, so there is still exactly one query in the app — is how. (`phoneTier.ts`
exports a second subscriber, `onPhoneTierChange()`, over that same one query;
it answers a different question — see *Crossing the breakpoint*.) CSS could only
have *hidden* the extra panes, which is strictly worse twice over:
`display: none` collapses the box `FitAddon` measures to zero (the trap
`docs/terminal.md` names for the cross-nav `visibility` toggle), and a
hidden-but-connected shell is a process the user can neither see nor reach.

**The pane tree is left intact, not pruned.** The unrendered leaves keep their
sockets open in `PtyPool` with their containers simply detached — the same
state a mid-reparent leaf is in for one commit — so widening past 600px
restores the whole layout. Pruning would have to kill them, and a Terminal-page
shell has no server-side session to reattach to. Verified: three panes carrying
distinct typed markers, narrowed to 390 (one rendered, header still reading
"3 panes", zero detached panes emitting frames), widened back to 1440 — all
three markers present, zero "shell closed" banners. The pane shown is the
**last** leaf, so that the Agent sidebar's rule is the same sentence: over
there the newest pane is the one you just tapped in the session list.

### The Agent drawer's list rail

The drawer is `min(24rem, 90vw)` — 351px — and the 'Agents' session-list rail
claimed 240 of that, leaving ~11 columns of terminal. Side-by-side is not
survivable at this width, but the rail *collapsed* is a 1.9rem strip, which
is. So the rail stays in flow when collapsed and becomes a full-drawer
`position: absolute` overlay when expanded, and `AgentSidebar` drives the two
states from the actions that mean them: attaching a session collapses the list
(otherwise the terminal renders underneath the list you opened it from), and
the pane's `close` — the only way back — re-expands it.

Measured with a stub agent attached: pane 296px wide, 44×53, rail collapsed to
30px; expanding the rail covers the pane (`z-index: 2`) without unmounting it,
and closing the pane returns the full-width list.

### Font size

xterm's font size is a JS option, so `--pty-font-size` carries it (13px in
`index.css`, 11px in the phone block) and `PtyTerminal`'s `ptyFontSize()`
reads the resolved value — the breakpoint stays in CSS with no second `600px`
in JS. Measured at 390×844: 13px is a 7.02px cell, 48 columns of a 337px
screen; 11px is 5.94px and **56 columns**. A phone pane is the whole screen,
so the columns are worth more than the glyph.

Changing the font changes the *cell*, not the box, so the `ResizeObserver`
never fires and an already-open terminal would keep stale `cols`/`rows` — the
explicit `fit()` after the option write is required, and was confirmed by
watching `cols` fail to move without it. A tier crossing therefore costs a
short converging burst (6 frames, 50→56 columns, measured) rather than one.
That is bounded and only reachable by a rotation, since portrait and landscape
sit on opposite sides of 600px; the keyboard path, which is the one that
repeats, stays at 1.

### Known gaps

- **The project Terminal tab is chrome-starved with a keyboard up.** 227px of
  project header and tabs plus 64px of `main` padding leave 112px of a 400px
  shell, i.e. a 1-row terminal — the prompt is visible (bottom 296 against a
  keyboard at 400) but little else is. `--tab-viewport-min`'s 256px floor is
  dropped for this one surface, and the duplicate `.terminal-page-header` is
  hidden here (the project tab strip above it already reads "Terminal"), which
  is what bought the prompt its place on screen. The global `#/terminal` page
  is the phone surface: same keyboard, 182px of terminal, 14 rows. Closing the
  rest of the gap means hiding the project chrome on focus, which is its own
  change.
- Nothing was verified on real hardware. The keyboard is a synthetic
  `visualViewport` resize in Chrome — faithful for height, silent on
  scroll-to-focus (above).

## Crossing the breakpoint

Most phone state is styling, and CSS re-evaluates a media query for free when
the viewport changes. The exception is a **React state value whose meaning
differs either side of 600px** — and there is exactly one: both sidebars'
`collapsed` flag, which selects an in-flow sidebar above the breakpoint and a
fixed overlay drawer below it (`.sidebar:not(.collapsed)` in the phone block).

`App.tsx` seeded that flag with `useState(isPhone)`, which decides it once, at
mount, and never again. Nothing re-decided it on a rotation, an iPad split-view
change, or a desktop window resize, so the flag stayed valid while its meaning
changed underneath it. Measured on the unfixed build:

| mounted at | resized to | result |
|---|---|---|
| 1200px, sidebar expanded | 390px | stayed expanded — a 256px overlay drawer nobody opened, covering two-thirds of the screen |
| 390px, sidebar collapsed | 1200px | stayed collapsed — a 34px stub rail on a wide screen |

The rule: **tier-dependent state is edge-triggered on the crossing, never
derived from the current tier.** `onPhoneTierChange()` in `phoneTier.ts` is
that edge — it wraps the same one `MediaQueryList`'s `change` event, which
fires only when `matches` flips.

Deriving instead (`collapsed = phone`) is the tempting shape and is wrong: it
re-asserts on every render, so it would reopen a drawer the user just closed.
Edge-triggering leaves intra-tier behaviour untouched — verified by opening the
drawer at 390px and resizing to 375px, where it stays open.

Entering the phone tier collapses **both** drawers, since both become fixed
overlays there and neither was opened as one. Leaving it restores only the nav:
the nav's wide-screen default is expanded, while the agents sidebar defaults to
collapsed at every width, so auto-expanding it on the way out would invent
state nobody asked for.

Keep the setState in the subscription callback rather than an effect body —
`react-hooks/set-state-in-effect` is a CI-gated lint error, and it is pointing
at the right design here, not merely a style.

## Verifying a phone change

Drive a real browser at a phone viewport (390×844 is the reference size) —
`@media` rules and touch gestures are not observable from a test suite or a
`curl`. Use a throwaway `MESA_DB` and a non-default port; never QA against a
live server holding real data.

Two traps specific to this rig, both of which make a broken build look fine:

- **A mount-only check cannot see a crossing bug.** Load at one width, resize
  to the other *without reloading*, and assert again — the whole class of
  defect above is invisible to a page that is only ever loaded at its final
  size.
- **`khora navigate` to the same hash is a no-op reload** on a hash-routed SPA,
  so React state survives it and leaks into the next case. Force a real remount
  with `location.reload()` between cases. A crossing test that skips this reads
  whatever the previous case left behind.

Measure overflow against `documentElement.scrollWidth - clientWidth` rather
than eyeballing a screenshot, and check `main`'s own `scrollWidth` too: `main`
is `overflow-x: auto`, so it absorbs runaway content into a sideways scroll and
the page-level number stays 0 while content sits off-screen. When walking
elements for offenders, an ancestor with `width: 0; overflow: hidden` (the
collapsed agent sidebar) clips its children without any of them reporting
`visibility: hidden` — those are false positives, not defects.

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
7. Open the Files tab, open a file: the tree goes, the toggle carries the
   path, and the content pane's top moves up the screen — quote the `top`,
   not "it looks better". Tap the toggle: the tree returns with the file
   still open. Then open that file's history and pick a commit: the diff is
   two grid columns, a context line appears **once**, and a changed line's
   `-` row sits directly above its `+` row. Re-run the same three at 1440px
   and assert the diff is back to four columns with zero hidden cells — that
   is the check that catches a phone rule leaking out of its media block.
8. Open `#/terminal`: one pane, full width, no `+ new shell`. Then simulate a
   keyboard and count PTY frames — this check has no shortcut, because
   `100dvh` looks correct right up until a keyboard exists. Chrome cannot
   raise one, so shadow the height and fire the event the app listens on:

   ```js
   Object.defineProperty(window.visualViewport, 'height',
     { get: () => 400, configurable: true })
   window.visualViewport.dispatchEvent(new Event('resize'))
   ```

   with `WebSocket.prototype.send` hooked per `docs/terminal.md`'s frame
   counter. Assert the terminal screen's `bottom` is `<= 400` **and** that
   exactly one `{"resize":…}` frame went out per live PTY. Prove the predicate
   first by pinning `#root` back to `100dvh` and re-running: the bottom must
   read 764, i.e. off screen. A passing `bottom` with `#root` still at 844px
   means the var never reached the box.
9. Open `#/cc/sessions` and swipe the table left: the panel's `<h2>` and the
   first column both hold their `left`, while column 2 goes negative. All
   three numbers matter — a sticky column that never moved because the
   scroll never happened reads exactly the same. Then **look at the rows**:
   the identity column is the one place a computed-style pass cannot tell a
   wrapped timestamp from a one-glyph-per-line column.
