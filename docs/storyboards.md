# Storyboards (freeform visual canvas)

A **storyboard** is a freeform spatial canvas of **frames** (cards at `x/y`) and
directed **frame_edges** between them — a Miro/Excalidraw-lite graph, distinct
from the kanban view of tasks. Tables `storyboards`, `frames`, `frame_edges`,
`storyboard_events` (migration index 4 = the boards, 5 = the change history).

- A storyboard belongs to a project, immutable after creation (like a task).
- A frame may optionally link a task **in the same project** (validated in
  `Store`); the link is `ON DELETE SET NULL`, so deleting the task clears it.
- Edges connect two frames **of the same board**; self-edges are rejected
  (`validation`). **Cycles are allowed** — a storyboard is a diagram, not a
  dependency graph, so there is deliberately no `would_cycle` check here.
- **Every storyboard/frame/edge mutation appends a `storyboard_events` row**
  (the change history) inside the same transaction: `actor` (free-text "who"),
  a stable `action` token, and a human `summary`. This is the collaboration
  record. `delete_storyboard` cascades frames/edges/events and writes no event
  (the history dies with the board; the delete echo is the recoverable record).
- CLI: `mesa storyboard {create,list,show,update,delete,events}` plus nested
  `frame {create,update,delete}` and `edge {create,update,delete}`. `show`/
  `delete` print the full `{storyboard, frames, edges}` view; `frame delete`
  echoes `{frame, edges}`; `events` prints the change log. Mutating commands
  take `--author` for attribution.
- API: `/api/storyboards` CRUD, `/api/storyboards/{id}/{frames,edges,events}`,
  `/api/frames/{id}`, `/api/edges/{id}`. Mutations attribute via an `author`
  body field (POST/PATCH) or `?author=` query (DELETE); it sets the change
  actor and never mutates an entity's own immutable `author`.
- **Connector routing waypoints** (spec 297): `FrameEdge.waypoints` is an
  ordered `Vec<Waypoint>` (`{x, y}`, absolute canvas coordinates — same space
  as `Frame.x/y`, not relative to either endpoint frame), added via migration
  index 13 on `frame_edges` (nullable `TEXT` column; NULL and `"[]"` both
  deserialize to `vec![]`, never distinguished). Always a plain array in JSON
  (never `null`), ordered from the `from_frame` end to the `to_frame` end.
  `EdgePatch`/`EdgeUpdate` gain a matching `waypoints: Option<Vec<Waypoint>>`
  field (`Store::update_edge`/API `update_edge` handler); a PATCH that changes
  it logs a `"edge_rerouted"` storyboard event (mirrors `edge_relabeled`) in
  the same transaction. No CLI flag for authoring waypoints — `show`/`delete`
  round-trip the field automatically as a struct member. An edge with an empty
  waypoint list renders byte-identical to before this feature (plain
  `nearestAnchor`/`getBezierPath` bezier between the two frames); one or more
  waypoints routes the path through them in order via
  `buildRoutedPath(from, to, waypoints)` in `frontend/src/StoryboardCanvas.tsx`
  (returns `{ path, anchors, mid }`, `anchors` = `[start, ...waypoints, end]`
  in absolute canvas coordinates — the seam the interactive layer builds on),
  with the start/end anchors snapping toward the first/last waypoint instead
  of the far frame's centre. The routed `path` is a smooth Catmull-Rom spline
  through `anchors` (`smoothPath`), not a straight poly-line, so a waypoint
  bends the connector rather than kinking it at a sharp corner; `mid` is the
  point at half the anchors' cumulative arc length (`midpointOfPolyline`),
  used to place the edge label on the actual route instead of the straight
  line between just the two endpoints, which drifts off to the side once a
  waypoint bends the connector. On the canvas: double-clicking
  a connector's path inserts a waypoint at the click point (ordered by nearest
  existing segment); dragging a waypoint's handle (rendered at each
  `anchors.slice(1, -1)` point) updates it live via local optimistic state and
  PATCHes the rounded position on release, reseeding from the server view
  afterward — mirroring `onNodeDragStop`'s local-drag-then-PATCH pattern;
  double-clicking a handle removes it, restoring the plain bezier once the
  array is empty again.
  `autoLayout()` never touches `waypoints` — it repositions frames only, so a
  large relayout can leave a stored waypoint visually "stale" relative to its
  frames until dragged/removed (an accepted tradeoff, not a bug).
