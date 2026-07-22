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
  `mesa storyboard frame {create,update,delete}` and `mesa storyboard edge
  {create,update,delete}` — frame/edge subcommands live under `storyboard`,
  not as top-level `mesa frame`/`mesa edge` commands. `show`/`delete` print
  the full `{storyboard, frames, edges}` view; `frame delete` echoes `{frame,
  edges}`; `events` prints the change log. Mutating commands take `--author`
  for attribution.
- API: `/api/storyboards` CRUD, `/api/storyboards/{id}/{frames,edges,events}`,
  `/api/frames/{id}` (PATCH/DELETE), `/api/edges/{id}` (GET/PATCH/DELETE).
  Mutations attribute via an `author` body field (POST/PATCH) or `?author=`
  query (DELETE); it sets the change actor and never mutates an entity's own
  immutable `author`.
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
- **Parallel edges between the same two frames** (mesa task 412): with no
  waypoints and both anchors unlocked, `buildRoutedPath` used to compute a
  byte-identical path/label position for every edge sharing both endpoint
  frames (in either direction — `A->B` and `B->A` land on the same two anchor
  points too), so two or more parallel connectors drew fully overlapped and
  only the topmost was ever clickable — the other could never be selected,
  relabeled, or deleted. `buildRoutedPath` now takes a `dupOffset` (px,
  signed): edges sharing an unordered frame pair (`parallelOffsets` in
  `StoryboardCanvas.tsx`, keyed by edge id) fan out evenly around the straight
  line via a perpendicular bow (rendered through the existing `smoothPath`
  spline machinery, `anchors` unchanged at `[start, end]` so waypoint
  insertion/handle rendering aren't affected). A lone edge between its two
  frames gets `dupOffset: 0` and renders byte-identical to before this fix;
  an edge with real waypoints already diverges naturally, so `dupOffset` is
  only applied in the plain-bezier (no-waypoints) branch.
- **Diagram types + per-frame shapes** (spec 355; `brainstorm` added by mesa
  task 444): a storyboard carries a
  `diagram_type` (`Storyboard.diagram_type: DiagramType`) — `storyboard`
  (default), `flowchart`, `erd`, or `brainstorm` — stored as a **bare
  lowercase string**
  (`as_str()`/`parse()`, same convention as `AnchorSide`/`Status`/`Priority`),
  added via migration index 17 alongside `frames.shape` (`ALTER TABLE
  storyboards ADD COLUMN diagram_type TEXT NOT NULL DEFAULT 'storyboard'` /
  `ALTER TABLE frames ADD COLUMN shape TEXT`, one migration entry, no new
  table). Every pre-feature storyboard backfills to `diagram_type:
  "storyboard"` for free via the column default; every pre-feature frame's
  `shape` reads back `null`.
  - **`diagram_type` is immutable after creation** — the same structural
    posture as `project_id`/`author`: there is no field for it on
    `StoryboardPatch`/the API's `StoryboardUpdate`, so there is no runtime
    guard to bypass. `storyboard update --type ...` doesn't exist as a flag;
    passing one is a clap **usage error (exit 2)**, not a domain `validation`
    error, because the patch type has no path to carry the value.
  - Each frame carries its own **`shape: Option<FrameShape>`** —
    `process`/`decision`/`start_end`/`entity`, or `None` for the generic
    card — because Must #5 requires a flowchart board to hold a *mix* of
    shapes simultaneously, so shape can't be inferred from the board's
    `diagram_type` alone; it's a per-frame property set at
    `FrameNew.shape`. `Store::create_frame` validates the given shape against
    the parent board's `diagram_type` via `validate_frame_shape`
    (`src/core/store.rs`), reading `diagram_type` off the same
    `get_storyboard` call `create_frame` already makes (no extra query):
    a `storyboard` board's frames must have `shape: None`; a `flowchart`
    board's frames must be one of `process`/`decision`/`start_end` (not
    `entity`); an `erd` board's frames must be `entity` (not any flowchart
    shape); a `brainstorm` board's frames must be `central` or `idea`. A
    mismatch is `Error::Validation` (`"shape '<shape>' is not valid
    for a <diagram_type> board"`). The whole matrix — every board type against
    its own shape set and every other shape, including the generic `None` card
    on a typed board — is covered by
    `frame_shape_must_belong_to_its_boards_diagram_type` in
    `src/core/store.rs`.
  - **`shape` is likewise immutable after creation** — no field on
    `FramePatch`/the API's `FrameUpdate`, mirroring `diagram_type`'s
    reasoning: a frame should never carry a shape from the "wrong" type
    system, and no story needs to re-shape a frame in place. `storyboard
    frame update --shape ...` doesn't exist as a flag; same clap usage-error
    posture as `storyboard update --type`.
  - CLI: `storyboard create <PROJECT> <TITLE> [--type
    storyboard|flowchart|erd|brainstorm]` (absent → `storyboard`, the column default;
    an unrecognized value is a clap usage error, exit 2, same posture as
    `--priority`). `storyboard frame create <STORYBOARD> <TITLE> [--shape
    process|decision|start_end|entity|central|idea]` (absent → `None`; an unrecognized
    value is a clap usage error, exit 2; a syntactically valid value that's
    wrong for the board's `diagram_type` is the `Store` `validation` error
    above, exit 1 — the CLI does not auto-correct or default a shape for a
    non-`storyboard` board, it just passes what it's given through to
    `Store`). Neither `storyboard update` nor `storyboard frame update` gets
    a corresponding flag (immutability, above). `storyboard show`/`list`/
    `delete` and `frame` reads need no CLI change — they already print the
    full `Storyboard`/`Frame`/`StoryboardView` object, so `diagram_type`/
    `shape` ride for free once the struct fields exist.
  - API: `POST /api/storyboards` accepts `#[serde(default)] diagram_type:
    Option<DiagramType>` in the request body (missing/`null` → `storyboard`);
    `POST /api/storyboards/{id}/frames` accepts `#[serde(default)] shape:
    Option<FrameShape>` (missing/`null` → `None`). Neither `StoryboardUpdate`
    nor `FrameUpdate` gains a field. A syntactically-invalid string for
    either (e.g. `"diagram_type": "bogus"`) fails to deserialize at the serde
    boundary → the existing `JsonRejection` 422 `validation` path, same as an
    invalid `AnchorSide` literal on `EdgeUpdate` today. A syntactically-valid but
    wrong-for-board-type shape is the same `Store` `validation` error as the
    CLI path. Every `Storyboard`/`Frame`/`StoryboardView` response (create,
    show, list, embedded in the board view) carries `diagram_type`/`shape`
    automatically — it's the same struct, not a projection.
  - Frontend node types (`frontend/src/StoryboardCanvas.tsx`): React Flow's
    per-node `type` is keyed off `Frame.shape`, not `diagram_type` —
    `diagram_type` only selects which shape *set* the creation UX offers.
    `toNodes` sets `type: (f.shape ?? 'frame') as FrameNodeKind`; `nodeTypes`
    maps `{ frame: FrameNode, process: ProcessNode, decision: DecisionNode,
    start_end: StartEndNode, entity: EntityNode, central: CentralNode,
    idea: IdeaNode }`. All seven components
    share one implementation, `FrameCardNode` — identical content, editing,
    and connection-handle behavior — distinguished only by an optional
    `shapeClass` (an extra CSS class on the card) and, for `EntityNode` only,
    a `renderBody` override (below). A `storyboard`-type board's frames all
    have `shape: null`, so they resolve to `type: 'frame'` / plain
    `FrameNode`, byte-identical to pre-feature rendering (the Must #6
    non-regression guard).
    - **Flowchart shapes** (`.frame-process`/`.frame-decision`/
      `.frame-start-end` in `frontend/src/App.css`): `process` is a plain
      rounded rectangle (`clip-path: none`); `start_end` is a soft capsule
      (`border-radius: 32px`, green border) with extra header padding so the
      title/id clear the curve — it was a full `999px` stadium until mesa
      task 445, which clipped both (see `.frame-central` below for the
      measurement); `decision` is **not** a `clip-path`
      diamond on the card itself (an earlier attempt clipped the title's
      leading letter and the `#id` badge at the diamond's narrow point) —
      instead the card stays a plain unclipped rectangle
      (`background/border: transparent`) and an oversized amber-bordered
      `::before` pseudo-element behind it (`z-index: -1`, `clip-path:
      polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)`) renders the diamond as a
      decorative backdrop/halo, so content is never clipped. Directed
      arrowheads on edges (`MarkerType.ArrowClosed`) already render
      unconditionally for every board type, pre-dating this feature — Must
      #7 needed no new edge-direction work.
    - **ERD shape** (`.frame-entity`): a plain rectangle tinted magenta,
      distinguished from `process` mainly by the attribute list, not the
      silhouette. `EntityNode` passes `FrameCardNode` a `renderBody` that
      wraps `Frame.body` in `.frame-entity-body` (tighter, monospace) and
      renders it through `<Markdown breaks>` — the same component every other
      shape uses, plus `remark-breaks` (mesa task 492). This is
      presentation-only: `Frame.body` is still a plain string (no new column,
      no JSON-in-`body` convention, no per-attribute typed structure) —
      nothing parses or validates an attribute format anywhere.
      **`breaks` is the load-bearing part.** Under plain CommonMark a single
      newline is a *soft* break that collapses to a space, so a
      line-per-attribute body like `"id: int PK\nname: string"` would render
      as one run-on line — an opaque prose blob, which Should #13 explicitly
      rules out. `remark-breaks` keeps each newline a visible line break, so
      that body still reads as two lines while emphasis, `` `code` ``, and GFM
      tables now render as formatting instead of literal source. Task 492
      replaced the original plain-text `<ul className="frame-attr-list">`
      (one trimmed `<li>` per non-empty line) for exactly that reason: an
      agent-generated ERD that describes columns as a markdown table showed a
      wall of `|` pipes. Card-scoped table CSS lives at
      `.frame-body :where(table)` and applies to every shape, not just
      entities.
    - **Brainstorm shapes** (`.frame-central`/`.frame-idea`, mesa task 444;
      the `.frame-start-end` note below is post-task-445):
      a mind-map hub plus its branch nodes. `CentralNode`/`IdeaNode` are both
      plain `FrameCardNode`s with only a `shapeClass` — no `renderBody`
      override, so bodies still render through `Markdown` like every shape
      but `entity`. `central` is a soft capsule (32px radius) with a 2px
      amber border and a permanent glow; `idea` is a lighter 12px-radius
      rounded rectangle with a green border. **`central` deliberately does
      not use the `999px` stadium radius `.frame-start-end` uses**: at the
      default 240x140 card that clamps to a 70px corner radius, which eats
      ~28px of horizontal space at the header's mid-height — more than any
      sane title padding clears, so the title's leading letter and the `#id`
      badge clip (the same failure that turned the decision diamond into a
      `::before` backdrop). `.frame-start-end` had the identical bug —
      measured at a 14.6px title inset against a ~28px curve — and mesa
      task 445 fixed it by adopting these same 32px/1.1rem values, so the
      two shapes now share one treatment. Nothing enforces one `central`
      per board — a brainstorm
      board is as freeform as every other storyboard, and the styling is the
      only thing that says "hub", exactly as the flowchart shapes only *look*
      like their roles. `SHAPES_FOR_TYPE.brainstorm` lists `idea` *before*
      `central` on purpose: the first entry doubles as the `defaultShape` for
      the quick-create gestures (pane double-click, drag-to-empty-canvas,
      Cmd+D duplicate), and those should mint a branch idea rather than a
      second hub.
  - Frontend creation UX: `StoryboardListView.tsx`'s new-storyboard form adds
    a `diagram_type` `<select>` (options
    `storyboard`/`flowchart`/`erd`/`brainstorm`, default `storyboard`) next to title/author, passed straight through to
    `createStoryboard(...)`. `StoryboardCanvas.tsx`'s add-frame toolbar reads
    `SHAPES_FOR_TYPE[view.storyboard.diagram_type]` (`storyboard: []`,
    `flowchart: ['process','decision','start_end']`, `erd: ['entity']`,
    `brainstorm: ['idea','central']` — kept
    in lockstep with `Store::validate_frame_shape`) to decide what to render:
    a `storyboard`-type board (empty shape set) keeps the original single
    "add frame" button, byte-identical markup to before this feature; a
    `flowchart`/`erd` board renders one button per valid shape instead (e.g.
    "+ process" / "+ decision" / "+ start/end"), each calling `createFrame`
    with that shape. The first shape in a board's set doubles as the
    `defaultShape` used by the canvas's other frame-creating gestures (pane
    double-click, dragging a connection to empty canvas, Cmd+D duplicate) so
    those keep working on flowchart/erd boards instead of hitting the
    `Store` validation error a bare `shape: null` create would now draw on a
    non-`storyboard` board.
  - **Untitled-on-create + collapsed description** (mesa task 448): every
    frame-creating gesture that mints a *fresh* frame (`addFrame` — the
    toolbar buttons and pane double-click — plus `onConnectEnd`'s
    drag-to-empty-canvas) sends `title: ''` and sets `editingId` to the new
    frame, so the card opens straight into a focused, empty title input with
    nothing to select-all over. That focus comes from a **callback ref that
    retries across animation frames**, not from React's `autoFocus`: a
    freshly-created React Flow node renders `visibility: hidden` until React
    Flow has measured it (two frames, measured in browser QA), and `focus()`
    on a hidden element is a silent no-op — so `autoFocus` and any one-shot
    mount effect both land on nothing and `document.activeElement` stays
    `<body>`. The retry is bounded (30 frames) and stops early once focus is
    inside the card, so it can't spin forever and can't yank the caret back
    out of the body textarea.
    `Store::create_frame` writes `added untitled frame (#N)` rather than
    `added frame '' (#N)` for the now-common empty title, keeping the
    storyboard history readable. It otherwise has no
    non-empty-title check, so an empty title is a legal stored value;
    `saveTitle` still refuses to *overwrite* a title with an empty one, and
    read mode renders a muted `untitled` for `f.title.trim() === ''` so an
    unnamed frame is still legible. `duplicateFrame` is deliberately excluded
    — a Cmd+D copy carries the source title and should not reopen for editing.
    Independently, `FrameCardNode` no longer renders the 4-row
    `.frame-body-input` textarea unconditionally while editing: `bodyOpen`
    (seeded from `(f.body ?? '') !== ''` and re-seeded on each edit session,
    same "adjust state during render on a prop change" pattern as the drafts)
    swaps it for a `.frame-add-body` "+ description" button when the body is
    empty. The textarea's `autoFocus={(f.body ?? '') === ''}` is true only on
    that button's click-to-mount path, so opening a frame that already has a
    body still lands focus on the title input rather than the body.
