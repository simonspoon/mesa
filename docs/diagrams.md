# Diagrams (freeform visual canvas)

A **diagram** is a freeform spatial canvas of **frames** (cards at `x/y`) and
directed **frame_edges** between them — a Miro/Excalidraw-lite graph, distinct
from the kanban view of tasks. Tables `diagrams`, `frames`, `frame_edges`,
`diagram_events` (migration index 4 = the boards, 5 = the change history; the
tables were named `storyboards`/`storyboard_events` until the rename migration).

- A diagram belongs to a project, immutable after creation (like a task).
- A frame may optionally link a task **in the same project** (validated in
  `Store`); the link is `ON DELETE SET NULL`, so deleting the task clears it.
- Edges connect two frames **of the same board**; self-edges are rejected
  (`validation`). **Cycles are allowed** — a diagram is a picture, not a
  dependency graph, so there is deliberately no `would_cycle` check here.
- **Every diagram/frame/edge mutation appends a `diagram_events` row**
  (the change history) inside the same transaction: `actor` (free-text "who"),
  a stable `action` token, and a human `summary`. This is the collaboration
  record. `delete_diagram` cascades frames/edges/events and writes no event
  (the history dies with the board; the delete echo is the recoverable record).
- CLI: `mesa diagram {create,list,show,update,delete,events}` plus nested
  `mesa diagram frame {create,update,delete}` and `mesa diagram edge
  {create,update,delete}` — frame/edge subcommands live under `diagram`,
  not as top-level `mesa frame`/`mesa edge` commands. `show`/`delete` print
  the full `{diagram, frames, edges}` view; `frame delete` echoes `{frame,
  edges}`; `events` prints the change log. Mutating commands take `--author`
  for attribution.
- API: `/api/diagrams` CRUD, `/api/diagrams/{id}/{frames,edges,events}`,
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
  it logs a `"edge_rerouted"` diagram event (mirrors `edge_relabeled`) in
  the same transaction. No CLI flag for authoring waypoints — `show`/`delete`
  round-trip the field automatically as a struct member. An edge with an empty
  waypoint list renders byte-identical to before this feature (plain
  `nearestAnchor`/`getBezierPath` bezier between the two frames); one or more
  waypoints routes the path through them in order via
  `buildRoutedPath(from, to, waypoints)` in `frontend/src/DiagramCanvas.tsx`
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
  `"edge_anchor_changed"` diagram event (checked first in
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
  `DiagramCanvas.tsx`, keyed by edge id) fan out evenly around the straight
  line via a perpendicular bow (rendered through the existing `smoothPath`
  spline machinery, `anchors` unchanged at `[start, end]` so waypoint
  insertion/handle rendering aren't affected). A lone edge between its two
  frames gets `dupOffset: 0` and renders byte-identical to before this fix;
  an edge with real waypoints already diverges naturally, so `dupOffset` is
  only applied in the plain-bezier (no-waypoints) branch.
- **Diagram types + per-frame shapes** (spec 355; `brainstorm` added by mesa
  task 444): a diagram carries a
  `diagram_type` (`Diagram.diagram_type: DiagramType`) — `storyboard`
  (default), `flowchart`, `erd`, or `brainstorm` — stored as a **bare
  lowercase string**
  (`as_str()`/`parse()`, same convention as `AnchorSide`/`Status`/`Priority`),
  added via migration index 17 alongside `frames.shape` (`ALTER TABLE
  storyboards ADD COLUMN diagram_type TEXT NOT NULL DEFAULT 'storyboard'` /
  `ALTER TABLE frames ADD COLUMN shape TEXT`, one migration entry, no new
  table — that shipped migration keeps the table's old name verbatim; the
  rename migration comes later). Note the surviving vocabulary: the
  *container* is a diagram, but `storyboard` remains one of its **types** —
  the plain freeform style, and the column default — so every pre-feature
  board backfills to `diagram_type: "storyboard"` for free; every pre-feature
  frame's `shape` reads back `null`.
  - **`diagram_type` is immutable after creation** — the same structural
    posture as `project_id`/`author`: there is no field for it on
    `DiagramPatch`/the API's `DiagramUpdate`, so there is no runtime
    guard to bypass. `diagram update --type ...` doesn't exist as a flag;
    passing one is a clap **usage error (exit 2)**, not a domain `validation`
    error, because the patch type has no path to carry the value.
  - Each frame carries its own **`shape: Option<FrameShape>`** — one of the
    named shapes, or `None` for the generic card — because Must #5 requires a
    flowchart board to hold a *mix* of shapes simultaneously, so shape can't be
    inferred from the board's `diagram_type` alone; it's a per-frame property
    set at `FrameNew.shape`. `Store::create_frame` validates the given shape
    against the parent board's `diagram_type` via `validate_frame_shape`
    (`src/core/store.rs`), reading `diagram_type` off the same
    `get_diagram` call `create_frame` already makes (no extra query). A
    mismatch is `Error::Validation` (`"shape '<shape>' is not valid
    for a <diagram_type> board"`). The whole matrix — every board type against
    every shape, including the generic `None` card on a typed board — is
    covered by `frame_shape_must_belong_to_its_boards_diagram_type` in
    `src/core/store.rs`. **The sets themselves are below**, under *Shapes and
    connectors*: task 854 widened every one of them, so the four-shape
    vocabulary this section shipped with is no longer the whole list.
  - **`shape` is likewise immutable after creation** — no field on
    `FramePatch`/the API's `FrameUpdate`, mirroring `diagram_type`'s
    reasoning: a frame should never carry a shape from the "wrong" type
    system, and no story needs to re-shape a frame in place. `diagram
    frame update --shape ...` doesn't exist as a flag; same clap usage-error
    posture as `diagram update --type`.
  - CLI: `diagram create <PROJECT> <TITLE> [--type
    storyboard|flowchart|erd|brainstorm]` (absent → `storyboard`, the column default;
    an unrecognized value is a clap usage error, exit 2, same posture as
    `--priority`). `diagram frame create <DIAGRAM> <TITLE> [--shape <SHAPE>]`
    (`mesa diagram types` lists the legal values per board type; absent → `None`; an unrecognized
    value is a clap usage error, exit 2; a syntactically valid value that's
    wrong for the board's `diagram_type` is the `Store` `validation` error
    above, exit 1 — the CLI does not auto-correct or default a shape for a
    non-`storyboard` board, it just passes what it's given through to
    `Store`). Neither `diagram update` nor `diagram frame update` gets
    a corresponding flag (immutability, above). `diagram show`/`list`/
    `delete` and `frame` reads need no CLI change — they already print the
    full `Diagram`/`Frame`/`DiagramView` object, so `diagram_type`/
    `shape` ride for free once the struct fields exist.
  - API: `POST /api/diagrams` accepts `#[serde(default)] diagram_type:
    Option<DiagramType>` in the request body (missing/`null` → `storyboard`);
    `POST /api/diagrams/{id}/frames` accepts `#[serde(default)] shape:
    Option<FrameShape>` (missing/`null` → `None`). Neither `DiagramUpdate`
    nor `FrameUpdate` gains a field. A syntactically-invalid string for
    either (e.g. `"diagram_type": "bogus"`) fails to deserialize at the serde
    boundary → the existing `JsonRejection` 422 `validation` path, same as an
    invalid `AnchorSide` literal on `EdgeUpdate` today. A syntactically-valid but
    wrong-for-board-type shape is the same `Store` `validation` error as the
    CLI path. Every `Diagram`/`Frame`/`DiagramView` response (create,
    show, list, embedded in the board view) carries `diagram_type`/`shape`
    automatically — it's the same struct, not a projection.
  - Frontend node types (`frontend/src/DiagramCanvas.tsx`): React Flow's
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
      board is as freeform as every other diagram, and the styling is the
      only thing that says "hub", exactly as the flowchart shapes only *look*
      like their roles. `SHAPES_FOR_TYPE.brainstorm` lists `idea` *before*
      `central` on purpose: the first entry doubles as the `defaultShape` for
      the quick-create gestures (pane double-click, drag-to-empty-canvas,
      Cmd+D duplicate), and those should mint a branch idea rather than a
      second hub.
  - Frontend creation UX: `DiagramListView.tsx`'s new-diagram form adds
    a `diagram_type` `<select>` (options
    `storyboard`/`flowchart`/`erd`/`brainstorm`, default `storyboard`) next to title/author, passed straight through to
    `createDiagram(...)`. `DiagramCanvas.tsx`'s add-frame toolbar reads
    `SHAPES_FOR_TYPE[view.diagram.diagram_type]` (`storyboard: []`,
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
    diagram history readable. It otherwise has no
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

## Shapes and connectors (mesa task 854)

Task 854 widens the vocabulary to a professional-tool-grade one: every diagram
type gets a real shape set, and an edge gets the connector properties a
drawing tool has. Both are **widening only** — every shape that was legal on a
board type before is still legal on it, and an edge that predates the feature
reads back with all three new fields `null`, which *is* today's rendering.

**One source of truth.** The sets live on `DiagramType` in
`src/core/types.rs`: `shapes()`, `allows_generic_frame()` and
`edge_markers()`. `Store::validate_frame_shape`/`validate_edge_markers` read
them, and so does `mesa diagram types`, so the validator and the discovery
command cannot answer differently — there is no second list to keep in step.
Each enum also carries an `ALL` (and `EdgeMarker::GENERAL`/`CARDINALITY`) that
`parse()`, the CLI's value parsers, its `a|b|c` error text and the exhaustive
matrix tests all walk.

### The shape matrix

| `diagram_type` | generic card (`shape: null`) | named shapes |
| --- | --- | --- |
| `storyboard` | **yes** (the pre-feature card) | `scene`, `note` |
| `flowchart` | no | `process`, `decision`, `start_end`, `data`, `document`, `database`, `predefined_process` |
| `erd` | no | `entity`, `weak_entity`, `relationship`, `attribute` |
| `brainstorm` | no | `idea`, `central`, `note` |

`note` is the one shape two types share — a sticky annotation is commentary,
not a member of either type system. `storyboard` keeping the generic card is
what makes every pre-feature frame (`shape: null`) still legal. Order is offer
order: the first entry doubles as the canvas's `defaultShape` for a
quick-create gesture, which is why `brainstorm` still lists `idea` before
`central`. `shape` stays **immutable after creation** — unchanged posture, no
field on `FramePatch`/`FrameUpdate`.

### Connector style and end markers

`FrameEdge` gains three nullable fields, added by **migration index 42**
(migration 43 — three `ALTER TABLE frame_edges ADD COLUMN ... TEXT`):

- **`style: Option<EdgeStyle>`** — `solid`|`dashed`|`dotted`. Valid on every
  board type; there is no per-type rule, because a dashed line means the same
  weakening on any diagram. `None` renders as today (solid).
- **`from_marker`/`to_marker: Option<EdgeMarker>`** — two families.
  The **general** family (`none`, `arrow`, `hollow_arrow`, `circle`,
  `diamond`) is valid on every board type; the **cardinality** family
  (`crows_foot`, `one`, `zero_or_one`, `one_or_many`, `zero_or_many`) states an
  ERD relation's multiplicity and is accepted **only on an `erd` board** — a
  crow's foot says nothing on a flowchart. A mismatch is `Error::Validation`,
  worded to mirror the shape one: `"marker '<marker>' is not valid for a
  <diagram_type> board"`. `None` on either end is today's rendering: nothing at
  the start, a closed arrowhead at the `to` end. Note `EdgeMarker::None` is a
  *different* answer from `Option::None` — it explicitly draws nothing at that
  end.

`validate_edge_markers` runs on **both** write paths. `create_edge` reads the
board's `diagram_type` off the existence check it already performed (the query
now selects the column instead of `EXISTS`, so it costs nothing extra);
`update_edge` fetches the board only when a marker is actually in the patch, so
a plain label or waypoint patch costs exactly the queries it did before.

**These three are mutable, unlike `shape`/`diagram_type`.** The immutability of
those two protects a structural invariant — re-shaping a frame would move it
into another type system, and a board can't change what kind of thing it is.
Restyling a connector changes nothing structural: it is the same relation
between the same two frames, drawn differently, and `validate_edge_markers`
re-runs on every patch so a marker can never land on a board type that rejects
it. So all three sit on `EdgePatch` and the API's `EdgeUpdate` under the
existing `double_option` pattern — `from_anchor`'s exact three-state contract:
omitted leaves it untouched, explicit `null` clears back to the default, a
value sets it.

A patch that actually changes any of the three logs **one** `edge_restyled`
diagram event naming only the parts that moved (`default` for a cleared one,
mirroring `anchor_summary`'s `unlocked`). In `update_edge`'s one-event-per-call
ladder it sits **second**: `edge_anchor_changed` stays first (anchors decide
where the connector attaches at all), then `edge_restyled` — a style or marker
changes what the connector *means* — then `edge_rerouted` and
`edge_relabeled`, which only change how that meaning is drawn or annotated. A
no-op patch still logs nothing, same as `label`/`waypoints`/anchors.

An edge still has no unbounded free-text field — all three additions are
bounded enum values, like `from_anchor` — so `--quiet` on the edge subcommands
stays a pass-through, byte-identical to the full output. The key-parity test
in `src/cli.rs` forces that decision explicitly.

### CLI

- `diagram frame create --shape` takes the extended set. Unrecognized literal =
  clap **usage** error (exit 2); syntactically valid but wrong for the board's
  type = `Store` **validation** (exit 1). Unchanged posture, wider set.
- `diagram edge create` gains `--style`, `--from-marker`, `--to-marker`
  (clap-parsed enums; an unknown literal never reaches `Store`).
- `diagram edge update` gains the same three inside the existing required
  `fields` `ArgGroup`, and `--style ""` / `--from-marker ""` / `--to-marker ""`
  clear back to the default exactly as `--label ""` does. The clearing form is
  why those three flags take a *validating pass-through* value parser
  (`parse_edge_style_or_clear`) rather than the enum parser: `""` is accepted
  and read back through `EdgeStyle::parse`/`EdgeMarker::parse` at the call
  site, where it parses to `None` — the clear — while any other unknown literal
  is still a usage error at exit 2 rather than a domain error at exit 1.
- **`mesa diagram types`** (new) prints a bare JSON array, one object per
  diagram type: `{type, shapes, generic_frame, edge_styles, edge_markers}`.
  This is the "matching options depending on the diagram type" surface — how an
  agent discovers the legal values instead of guessing and taking a
  `validation` error. It is a **read** command, so it rejects `--quiet` as an
  unknown argument (exit 2), like `list`/`events`. It is also the one diagram
  command that opens **no database**: the sets are compiled in, so it answers
  before `Store::open_default()` and never creates a db as a side effect.
  `scripts/diagram-check.sh` drives its whole shape/marker matrix off this
  command's output — every value it lists must create, every value it omits
  must be rejected — so the two can't drift.

### API

`POST /api/diagrams/{id}/edges` accepts the three as `#[serde(default)]`
optionals; `PATCH /api/edges/{id}` accepts them as `double_option` fields. An
invalid literal fails to deserialize at the serde boundary → the existing 422
`validation` path, same as a bad `AnchorSide` today; a valid-but-wrong-for-type
marker is the `Store` validation error, also 422. No other route changed, and
every response carries the new fields automatically — same struct, not a
projection.

## The index rows (mesa task 854)

`DiagramListView.tsx` renders one **row** per board — a thumbnail of its
current saved state, then the title (the link to the canvas), the description
and a meta line of author, `diagram_type` and the updated time. The create
form above it is untouched, and so is the hash route each title links to.

- The date goes through `time.ts` (`timeAgo`, with `formatTimestamp` as the
  `title=` tooltip) like every other timestamp the app renders — the raw
  SQLite string this row used to print is UTC with no zone marker, so it read
  hours off for anyone not on UTC.
- The thumbnail is **inline SVG built from the board's own frames and edges**,
  not an image and not a stored render: frames as small rounded rects, edges as
  straight centre-to-centre lines. All of the geometry is the pure module
  `frontend/src/diagramThumb.ts` (`diagramThumb(frames, edges, w, h)` →
  `{viewBox, rects, lines}`), which fits the frames' bounding box into the
  target box letterboxed and centred, aspect ratio preserved. It answers
  **`null` for a board with no frames** — there is no box to fit and an empty
  `<svg>` reads as a broken image, so the component draws an inert placeholder
  instead. A zero-area bounding box (every frame stacked on one point) never
  divides by zero: an axis of no extent constrains nothing, and a board that is
  a single point falls back to scale 1. Negative frame coordinates are ordinary
  — only the bounding box's *shape* reaches the output, never where it sits.
  Each rect carries its frame's `shape` and `color` through so the mini-map can
  hint them (a capsule corner, the frame's own stroke); it deliberately does
  **not** reimplement the canvas's shape silhouettes — at 128×80 none of that
  reads, and `DiagramCanvas.tsx` stays the one renderer of a real board.
- `GET /api/diagrams` returns `Diagram` rows only, so each row's frames/edges
  are a **second read** — the existing `getDiagram(id)` view fetch, one per
  listed board. They are fetched once per *set of listed ids* (and on window
  refocus, like every other view), keyed on that id list flattened to a string,
  so a resolved fetch writing state can never re-trigger the effect. A view
  that fails is swallowed: that row keeps the placeholder and the page is
  unaffected. No route changed for this.

## The canvas (mesa task 854)

`DiagramCanvas.tsx` renders the widened vocabulary above. Two rules hold the
whole section together: **the offered sets are the server's sets**, and
**nothing a shape does may clip a card's content**.

### One table, tested

`SHAPES_FOR_TYPE`, `markersForType`, `EDGE_STYLES` and their labels live in
the pure module `frontend/src/diagramOptions.ts` (with
`diagramOptions.test.ts`), not inline in the `.tsx` — the same reason every
other pure module in that folder exists, and here with a concrete stake:
offering a value the server rejects turns an ordinary click into a 422 the
user cannot act on, so the test transcribes `DiagramType::shapes`/
`allows_generic_frame`/`edge_markers` and asserts the whole matrix, including
that the cardinality markers are offered on an `erd` board **only**.

`SHAPES_FOR_TYPE` is `(FrameShape | null)[]`, deliberately widened from
`FrameShape[]`: `null` is the generic card, and `storyboard` now lists it
**first** rather than expressing it by being the empty set. The first entry is
still `defaultShape` for the quick-create gestures (pane double-click,
drag-to-empty-canvas, Cmd+D), so that ordering is what keeps a storyboard
board's quick-create minting exactly the plain card it always did.

Where those shapes are *offered* moved in mesa task 868 — see "Shape palette"
below. Until then they were a wrapping cluster of text buttons inside the
in-canvas `.canvas-controls` panel, the generic card's button keeping the
original "add frame" wording at the head of it.

### Shape palette (the left toolbar, mesa task 868)

The shapes a board offers are a **rail down the left of the diagram space**:
one row per entry of `SHAPES_FOR_TYPE[diagram_type]`, in that same offer
order, each row drawing the shape's **silhouette** beside its **name** — so a
board's vocabulary reads as pictures, not as a list of words.

- **A row is dragged onto the canvas** and the frame lands where it is dropped,
  centred on the drop point (`dropPosition` — the create sends no `w`/`h`, so
  `src/api.rs`'s 240×140 default stays the single definition of frame size and
  the palette only borrows the number to centre). Drag is HTML5
  drag-and-drop on a `<button>`, layered *on top of* the click: clicking a row
  still creates the frame at the old stagger position, which is what the button
  cluster did, and keeps the palette keyboard-reachable (Enter activates).
- **The drop payload is re-checked against this board's own shape set.** A drop
  can carry anything — a file, a drag from another app, a row dragged out of a
  board of a different type in another tab — so `decodeShapeDrag` honours a
  payload only when `SHAPES_FOR_TYPE` lists it for *this* `diagram_type`, and
  answers "not a shape drop" otherwise. Offering the canvas a shape the server
  rejects would be a 422 on a gesture with no undo. The success value is
  wrapped (`{shape}`) precisely so the legitimate generic card (`shape: null`)
  stays distinguishable from a rejected drop. The private mime
  (`application/x-mesa-frame-shape`, not `text/plain`) is what lets `dragover`
  tell a palette drag from anything else *before* the drop, so a file dragged
  onto the canvas still behaves as it did. It cannot tell which *board* the
  row came from — protected mode hides the payload until the drop — so a row
  dragged across tabs onto a board of a different type is accepted by
  `dragover` and then refused by `decodeShapeDrag`, silently. That is the
  right way round: the alternative is a 422.
  `dragenter` is bound to the same handler as `dragover` (as the files tree
  and the pane tabs do): an element is a drop target only from the moment one
  of the two calls `preventDefault()`, so a flick that releases before the
  first `dragover` tick would otherwise be refused.
- **It is a real column beside the viewport, not an overlay.** A flowchart
  board offers 7 shapes and 7 rows tall enough to carry a silhouette would have
  covered the drawing — the same failure the wrapped button cluster was the fix
  for. Outside the canvas box it also cannot eat a pan gesture. The rail
  scrolls at the viewport's own height, so a board type gaining shapes
  lengthens the rail rather than the page.
- **Phone tier**: a finger cannot start an HTML5 drag, so the rail degrades to
  what it already is underneath — one horizontally-scrolling strip of
  tap-to-add rows above the canvas, at the tier's 44px floor.
- The decidable-without-a-tree part (which rows a board offers, the payload
  encoding, the drop position) is `shapePalette.ts` with
  `shapePalette.test.ts` over it; the silhouettes are markup and stay in
  `DiagramCanvas.tsx` (`ShapeIcon`) beside the node components they mirror.
  They are **redrawn in SVG rather than reusing the nodes' CSS**: a node's
  silhouette is built from card-sized rules (oversized `::before` backdrops,
  clip-paths sized to a 240×140 card) that do not survive being shrunk into a
  palette row.

### Shape silhouettes

`nodeTypes` maps all 15 shapes; every one is the same `FrameCardNode` with a
`shapeClass`, and `weak_entity` additionally reuses `entity`'s `renderBody`
(a weak entity's attributes read exactly like an entity's).

The hard-won rule from `decision` and `central` — a `clip-path` or a large
radius on the card itself eats the title's leading letter and the `#id` badge,
which sit in the top corners — decides the technique per shape:

| shape | technique |
| --- | --- |
| `scene` | card unchanged; an inset film-strip band (`::after`) along the bottom, with matching `padding-bottom` |
| `weak_entity` | `border: 4px double` — the notation's double border is just the card's own border |
| `predefined_process` | `border-left/right: 5px double` + header padding — the two side bars, again on the card's own border |
| `note` | backdrop, fold clipped from a corner inflated 22px to the **right** so the fold falls past the card and the `#id` badge stays clear; `::after` paints the turned-up flap |
| `data` | backdrop inflated 22px each side, parallelogram `clip-path` |
| `document` | backdrop inflated 24px at the bottom, wave `clip-path` cut from that overhang |
| `database` | backdrop with `border-radius: 50% / 14%` (the cylinder) inflated 18px vertically, `::after` redrawing the top ellipse |
| `relationship` | backdrop diamond, the flowchart `decision` treatment in magenta |
| `attribute` | backdrop ellipse, symmetric so it stays centred, inflated 45% vertically — measured: at 26% the card's top edge sat where the oval is only ~122px wide against the card's own 240, i.e. right on the title and `#id` badge; at 45% it is ~294px wide there |

"Backdrop" is `decision`'s construction: the card goes transparent and keeps
its content unclipped while an oversized `::before` at `z-index: -1` carries
the silhouette, with `.selected`/`.editing` moving that backdrop's border to
cyan. The six backdrop shapes share one rule block in `App.css` and differ
only in inflation and clip.

### Connector rendering

`FrameEdgeView` reads the three new fields off `data` and falls back to
exactly today's picture for each `null`:

- **`style`** → `dashArrayFor` on the `BaseEdge` path. `null` and `solid` both
  answer `undefined`, i.e. no `stroke-dasharray` property at all.
- **`to_marker: null`** keeps React Flow's own resolved `markerEnd` (the
  closed cyan `MarkerType.ArrowClosed` the parent still puts on every edge
  object), and **`from_marker: null`** draws no start marker. `EdgeMarker`'s
  own `none` is the *explicit* "draw nothing" answer and is therefore a
  different thing: at the `to` end it clears that arrowhead.

Every other marker is a `<marker>` this canvas defines itself — React Flow's
`MarkerType` knows only arrowheads. `EdgeMarkerDefs` renders them once into a
zero-size `<svg>` inside `.diagram-viewport` (a `url(#id)` reference resolves
document-wide, so they need not live inside React Flow's own SVG, which we do
not own). Three details make one definition serve both ends:
`orient="auto-start-reverse"` (at `marker-start` the glyph is flipped, so it
points back down the path — no start/end pair to define),
`fill`/`stroke: context-stroke` (a marker can never disagree with the colour
of the line it terminates; the hollow glyphs fill with `var(--panel)` so the
line behind them does not show through), and
`markerUnits="userSpaceOnUse"` (one size in flow coordinates rather than
scaling with the 2px stroke). Geometry convention: +x runs along the path
**toward** the endpoint, so the right edge of each viewBox sits on the frame
and the crow's foot fans back down the line.

### Editing a connector

No new panel: the label cluster is already the edge's one affordance (inline
label, delete ✕, and the anchor-lock dots hanging off the same hover), so a ⋮
button beside the ✕ opens a small properties block under it with three
selects — line, start, end. That block is a **flow child** of `.edge-label`,
not an absolutely positioned overlay: as an overlay it laid out at the right
coordinates and painted nothing at all. `.edge-label` is an
`EdgeLabelRenderer` child inside React Flow's transformed viewport and is
centred on the connector by its own `translate(-50%, -50%)`, so a panel
hanging below that box escapes into a layer this canvas does not own and, near
the bottom of a board, straight through `.diagram-viewport`'s
`overflow: hidden`. In flow it is part of the one box already known to paint,
and the centring transform re-centres the taller cluster on the connector.

Two details follow from that. The `z-index` that lifts the open cluster over
React Flow's node layer (a frame's card otherwise paints over the block) has
to sit on `.edge-label` itself, not on the block: `.edge-label` carries the
positioning transform, so it *is* a stacking context and a z-index on any
child only sorts inside it. And each row's name is a `<span>` with a fixed
flex basis rather than a bare text node — as a shrinkable flex item beside the
select, `line` collapsed to nothing while `start`/`end` still read.

Each `<option value="">` is `default` and PATCHes an
explicit `null`, which is the `double_option` "clear" and why the three-state
contract matters here. The marker selects list `markersForType(diagramType)`
only, so the ERD cardinality family is unreachable on a board that would 422
it. Every change is one `PATCH /api/edges/{id}` through the existing
`updateEdge` client (`EdgePatch` gained the three fields), then the usual
refetch — no local optimistic copy, exactly like the anchor-lock click.

## Silhouette geometry: what the shape occupies vs what the card does (mesa task 892)

Every non-rectangular shape is drawn as an oversized `::before` backdrop behind
an **unclipped** card, for the reason `.frame-decision` established and
`App.css` records: a `clip-path` on the card itself eats the header, where the
title's leading letter and the `#id` badge live. That rule stands. What task
892 fixed is everything that rule left unsaid.

**Three defects, one cause: nothing agreed on how big a shape actually is.**

- *Content crossed its own outline.* The backdrop was inflated by eye, so text
  hung outside the diamond and the parallelogram cut through the body. The
  inflations are now derived, and each derivation is written beside the value
  in `App.css` — a rectangle inscribed in a diamond `1.4w x 1.7h` may occupy
  the middle **57.6%** of the card's width, so the two diamond shapes pad
  their content **22%** on each side and centre it; an oval needs `>= 20.7%`
  inflation on both axes to clear its card's corners, so `attribute` sits at
  **24%** (the bound plus the margin the bound does not cover: a border, the
  antialiasing, and a glyph's ink not being its line box). The `%`-based
  silhouette details that failed at any *other* card size — the parallelogram's
  `14%` slant against `22px` of inflation, the document's `84%` wave, the
  cylinder's `14%` cap — are now px, matched to their own inflation.
- *A clipped backdrop drew no outline at all.* A `clip-path` cuts the element
  at the polygon while a CSS border is painted around its **box**, so a
  clipped, bordered backdrop kept its border only where polygon and box touch
  — for a diamond, four single points. Both diamonds, the parallelogram and
  the document were flat unoutlined blobs. Those four are now **two stacked
  layers**: `::before` paints the whole silhouette in the outline colour and
  `::after` repaints it in the fill, inset `1.5px`, leaving exactly a rim
  (`drop-shadow`, not `box-shadow`, for the selected glow — it follows the
  clip). `note` and `database` keep a real border, because neither clips the
  edge its border runs along, and both already use `::after` for something
  else.
- *Nothing outside the CSS knew the backdrop existed.* Auto-layout packed
  frames by their stored `w`/`h` and connectors anchored to the card's measured
  box, so a diamond 1.7x as tall as its card sat on both its neighbours and
  every connector stopped well inside the shape it pointed at.
  **`frontend/src/shapeBox.ts`** is now the one place the two worlds meet:
  `SHAPE_BLEED` mirrors each backdrop's `inset` one-for-one and `outerBox()`
  turns a card box into the box the shape occupies. `FrameEdgeView`'s `rect()`
  inflates by it (so an endpoint lands on the outline), and `autoLayout()`
  lays out the **measured** node inflated by it, then puts each frame's own
  top-left back inside its silhouette by the same bleed — measured, because a
  card's stored `h` is a `min-height` it grows past to fit its text.
  `shapeBox.test.ts` is the tripwire for the table and `App.css` drifting
  apart; **change an `inset` there and the matching entry here, or the canvas
  silently goes back to overlapping.**

Two more things follow from the silhouette becoming the node's real extent:

- **The four connection dots moved out to the outline too.** A handle is a
  sibling of the card and React Flow pins it to the node wrapper's own edge —
  which on a shaped frame is the card, not the shape. Once a connector attached
  to the outline, the dot you grab and the point the line lands on were the
  whole bleed apart, and the anchor-lock dots (computed from the same outline)
  no longer sat just past their handles. `shapeBleedCss()` is the one extra
  export that exists for this: the same table as a CSS length per side, because
  this consumer needs an offset the browser resolves against the card rather
  than a number of px.
- **A shape's own rules stand down while its card is being edited.** An open
  card is a form — title input, body textarea, colour/task/delete row — and all
  of it wants the card's full width; centred and inset to 22% the title input
  was narrow enough to scroll its own text out of view. The backdrop keeps
  drawing behind the open editor (it is still that frame's shape), but the
  content is left alone until the edit ends.

And two smaller readability fixes ride along, both in the same "the drawing
should be followable" spirit:

- **An edge label sits at the curve's own midpoint**, which `getBezierPath`
  hands back, not at the midpoint of the straight chord between the endpoints.
  The two agree only when the curve is nearly straight; as soon as a connector
  leaves one frame's side and arrives at the next one's top — the common case
  in a branching flowchart — the chord midpoint sits off in bare canvas, or on
  top of an unrelated frame, with nothing to say which connector it labels.
- **Auto-layout centres its layers on each other** (`layout.ts`) instead of
  packing every layer against `ORIGIN`. Left-aligned, a one-frame layer sat at
  the top edge of a three-frame one, so a branch and the trunk it rejoins were
  never on the same line and every connector between them arrived at a slant.
- **An edge that spans more than one layer gets a dummy in each layer it
  crosses** (`layout.ts`) — the Sugiyama step this layout was missing. A dummy
  takes no room of its own, so what it buys is the `GAP_NODE` on either side of
  it: a clear channel from the edge's source to its target. Without one, a
  connector spanning four layers was drawn straight across whatever sat between
  its ends, and in QA it ran right through an unrelated node's card. Dummies
  join the crossing-reduction pass too, which is what keeps the channel roughly
  straight; they never reach the caller, which still only sees positions for
  real frames.
