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
- **Locked connector anchors** (spec 348): each edge endpoint may be locked to
  a specific side of its frame instead of floating to whichever side
  `nearestAnchor` currently computes. `FrameEdge.from_anchor`/`to_anchor` are
  `Option<AnchorSide>`, added via migration index 16 on `frame_edges`
  (nullable `TEXT` columns, appended right after the `result` column entry at
  index 15). `AnchorSide` (`Top`/`Right`/`Bottom`/`Left`) is stored as a
  **bare lowercase string** (`"top"`, `"right"`, ...) via `as_str()`/`parse()`
  — the same convention as `Status`/`Priority`, and deliberately **not**
  JSON-encoded like `waypoints` (a single typed enum in one column is a
  closer fit to `Status`/`Priority` than to a JSON-serialized `Vec<Waypoint>`
  collection). The four string values are byte-identical to React Flow's own
  `Position` enum, so no translation table is needed on the frontend — though
  a value read off `FrameEdge.from_anchor`/`to_anchor` still needs a type-level
  `as Position` cast, since ts-rs generates `AnchorSide` as its own
  string-literal union, not the same TS type as `Position`.
  `EdgePatch`/`EdgeUpdate` gain `from_anchor`/`to_anchor: Option<Option<AnchorSide>>`
  via the existing `double_option` pattern (also used for `label`,
  `description`, `parent_id`, ...) — **a three-state contract per endpoint**:
  omitted leaves the current lock untouched, explicit `null` unlocks (back to
  floating), a valid side string locks (or directly re-locks to a different
  side, no separate unlock step needed). This is stricter than `waypoints`'
  own two-state contract (`None` = untouched, `Some(vec)` = replace, including
  `Some(vec![])` to clear) — do not assume the same shape reading from one to
  the other. An invalid side literal fails to deserialize `EdgeUpdate` at the
  serde boundary, mapped to a 422 `validation` error the same way an invalid
  `status`/`priority` literal is today; there is no separate `Store`-level
  check. A PATCH that actually changes either anchor logs a single
  `"edge_anchor_changed"` storyboard event (checked first in
  `Store::update_edge`'s one-event-per-call priority, ahead of
  `edge_rerouted`/`edge_relabeled`) naming which end(s) changed and to/from
  which side; a patch that re-asserts the already-locked side (or otherwise
  changes nothing) logs nothing, same as `label`/`waypoints`. On the canvas,
  `buildRoutedPath` substitutes a locked side for `nearestAnchor(...)` in
  **both** branches — the plain-bezier (no-waypoints) branch and the
  waypoint-routed branch — so a locked endpoint holds its side even once
  waypoints exist; an edge with both ends unlocked takes neither branch's
  locked path and renders byte-identical to before this feature. Hovering an
  edge reveals 8 small anchor-lock dots (4 per endpoint, positioned just
  outside each frame's own connection handles); a filled dot marks that
  endpoint's current locked side, the other three (all four, if unlocked)
  render outline-only. Clicking an outline dot locks (or re-locks) that
  endpoint to that side; clicking the filled dot unlocks it back to floating.
  The two endpoints are fully independent, so mixed lock state (one end
  locked, the other floating, or each locked to a different side) is valid.
  No CLI flag for authoring anchors — same "round-trips automatically as a
  struct member, no setter" treatment as `waypoints`.
