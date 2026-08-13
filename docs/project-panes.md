# Project view panes — the Custom tab

Drag a project view tab (Dashboard, Board, Diagrams, Git, Files, Terminal,
Settings) into the main area and it is added *beside* what is already there as
a new pane. The first such drop mints a **Custom** tab, first in the strip,
which is where that layout lives from then on. Clicking any other tab still
fills the whole area with that one view, exactly as before (task 843).

Frontend-only: no CLI, no API, no Rust surface. The layout is machine-local
(localStorage), like the last-view memory and the Files tab's folder memory —
never project or server data.

## The three moving parts

| Piece | File | Owns |
|---|---|---|
| Tree + memory | `frontend/src/projectPanes.ts` | the pure gestures and the per-project localStorage |
| Chrome | `frontend/src/components/ProjectPanes.tsx` | pane headers, dividers, drop targets |
| Page | `frontend/src/pages/ProjectTasksPage.tsx` | the tab strip, the route, which view each pane renders |

The split tree itself is **not** new: it is `frontend/src/lib/paneTree.ts`, the
same engine the Agent sidebar and the Terminal page use, instantiated at
`contentKind: 'view'`. Every gesture here is that engine's `resolveDrop` — so
the edge zones, the split orientation, the ratios and the canonicalization
match those surfaces instead of being a second interaction model.

## Two invariants

- **A leaf's id *is* its tab name.** A view therefore appears at most once: a
  drag of an already-open view *moves* its pane rather than opening a second
  copy, which falls out of `dropTab` removing the leaf before re-inserting it.
  A stored tree holding the same view twice is rejected on read.
- **A drop is `resolveDrop` after an append.** `dropTab` appends the dragged
  tab to root and hands the tree straight to the shared engine, so the only
  thing this module decides is *what* is being dropped, never *how* a drop
  resolves.

## The gesture

Both drop surfaces are one component, `TabDropArea`:

- On a **plain tab** the whole content area is the target and the tree behind it
  is `singlePane(<that tab>)` — dropping Files on the Board's right edge means
  "board beside files". The page then navigates to `#/projects/:id/custom` to
  show the result. A drop that changes nothing (a tab onto its own view) never
  mints a one-pane Custom tab.
- On the **Custom tab** every pane is a target, and a pane's own header is a
  drag handle carrying the same payload — so rearranging an open pane and
  dragging a fresh tab in are the same code path.

The drag payload is a dedicated MIME type, `application/x-mesa-tab`, not
`text/plain`: the Files tab drags file paths and editor tabs around as
`text/plain`, and `dragover` can only read `dataTransfer.types`, never the
value, so the two kinds of drag can only be told apart by the type itself. A
Files drag over a pane therefore passes straight through, and dragging inside a
pane still behaves exactly as it does on that view's own tab.

Center-of-pane drops land the view *beside* the target with no new split, and
show a whole-pane outline rather than the half-pane preview an edge drop shows
— there is no half to preview.

## Route and memory

`#/projects/:id/custom` is a URL-driven view like every other project tab, so
it is back- and refresh-stable, and `lastView.ts` remembers it as that
project's tab — which is what makes "move away and come back" restore the
layout. The route is a **link only**: a project whose layout has since been
emptied renders the Board at that route rather than an empty frame.

The Custom tab is on the strip **iff** that project has a remembered tree.
Closing the last pane deletes the memory, takes the tab back off the strip and
returns the page to the Board — there is no way to be left on a tab that shows
nothing.

## Sizing

A view inside a pane is bounded by the pane, not the window. The view-filling
tabs (Files, Git, Terminal, Diagrams) size their bodies off
`--tab-viewport-height`, which asks for a full screen; `.project-pane-body`
redefines that variable (and `--tab-viewport-min`) to the pane's own box, so
one CSS declaration rebinds every one of them with no per-view change.

## Opening a task from a Board pane

A card's link is a route (`#/projects/7/tasks/12`), so following it from a
Board *pane* would leave the Custom tab and tear the layout down to show one
task. The Custom route therefore carries the task id too —
`#/projects/7/custom/tasks/12` — and a card decides which of the two to link
from the hash it is rendered under (`taskHrefFrom`), so the modal opens over
the panes and closing it returns to them.

## Known limits

- **Moving a pane remounts its view.** React reparents the leaf, so a pane
  dragged into a different split loses view-local state (an unsaved editor
  buffer in a Files pane, say). A Terminal pane survives it — its shells live
  in the always-mounted `PtyPool` and its tree is kept per scope — but nothing
  else has that mitigation. Rebuilding it for every view would mean a pane pool
  like `PtySlot`'s, which this task deliberately did not take on.
- **A Diagrams pane shows the list only.** Opening a single board is its own
  route (`/diagrams/:sid`), which is not a Custom route, so it navigates away
  from the layout.
