import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  ConnectionMode,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  getBezierPath,
  useConnection,
  useInternalNode,
  useNodesState,
  useReactFlow,
  type Connection,
  type ConnectionLineComponentProps,
  type Edge,
  type EdgeProps,
  type FinalConnectionState,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
  type Viewport,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  createEdge,
  createFrame,
  deleteEdge,
  deleteFrame,
  updateEdge,
  updateFrame,
  type FramePatch,
} from './api'
import { loadBoardView, saveBoardView } from './boardView'
import { ConfirmDelete } from './components/ConfirmDelete'
import { InlineEdit } from './components/InlineEdit'
import { Markdown } from './components/Markdown'
import {
  EDGE_STYLES,
  MARKER_LABELS,
  SHAPES_FOR_TYPE,
  dashArrayFor,
  markerUrl,
  markersForType,
} from './diagramOptions'
import { layoutFrames, type LayoutDirection } from './layout'
import {
  SHAPE_DRAG_MIME,
  decodeShapeDrag,
  dropPosition,
  encodeShapeDrag,
  paletteItems,
} from './shapePalette'
import type { AnchorSide } from './types/AnchorSide'
import type { DiagramType } from './types/DiagramType'
import type { DiagramView } from './types/DiagramView'
import type { EdgeMarker } from './types/EdgeMarker'
import type { EdgeStyle } from './types/EdgeStyle'
import type { Frame } from './types/Frame'
import type { FrameShape } from './types/FrameShape'
import type { Waypoint } from './types/Waypoint'

const MIN_ZOOM = 0.25
const MAX_ZOOM = 3

/** Every React Flow node `type` string this canvas can produce: the generic
 *  `'frame'` card (a `storyboard`-type board, or any frame with `shape ===
 *  null`) plus every `FrameShape` value. */
type FrameNodeKind = FrameShape | 'frame'

// The per-board-type shape/marker vocabularies (`SHAPES_FOR_TYPE`,
// `markersForType`, their labels) live in `diagramOptions.ts` — they mirror
// the server's own matrix (`DiagramType::shapes`/`edge_markers`), and that
// lockstep is what `diagramOptions.test.ts` checks.

/** Node payload: the server frame, its selected/editing state (owned by this
 *  component, not React Flow's own click-select, so they can never disagree
 *  with the rendered highlight), plus the mutation callbacks the inline
 *  edit form needs. Callbacks ride in `data` so the node stays a plain
 *  presentational component, matching `FrameEdgeType` below. */
type FrameNodeType = Node<
  {
    frame: Frame
    selected: boolean
    editing: boolean
    projectId: number
    onSaveTitle: (next: string) => Promise<void>
    onSaveBody: (next: string) => Promise<void>
    onSaveColor: (next: string | null) => Promise<void>
    onSaveTask: (next: number | null) => Promise<void>
    onDelete: () => Promise<void>
    onDone: () => void
  },
  FrameNodeKind
>

/** Edge payload: the server label plus the mutation callbacks the label
 *  controls need. Callbacks ride in `data` so the custom edge stays a plain
 *  presentational component. */
type FrameEdgeType = Edge<
  {
    label: string | null
    waypoints: Waypoint[]
    fromAnchor: AnchorSide | null
    toAnchor: AnchorSide | null
    /** Perpendicular bow (px, signed) applied to this edge's drawn path when
     *  it shares both endpoint frames with one or more other edges — see
     *  `parallelOffsets` below. Zero for a lone edge between its two frames. */
    dupOffset: number
    /** Connector properties (mesa task 854). All three `null` — the stored
     *  default, and every edge predating the feature — renders exactly as
     *  before: a solid line, nothing at the start, React Flow's own closed
     *  arrowhead at the `to` end. */
    style: EdgeStyle | null
    fromMarker: EdgeMarker | null
    toMarker: EdgeMarker | null
    /** The board's type, which decides which markers may be *offered*: the
     *  ERD cardinality family is `erd`-only server-side, so offering it
     *  elsewhere would only produce a 422. */
    diagramType: DiagramType
    onSaveLabel: (next: string) => Promise<void>
    onDelete: () => void
    onSaveWaypoints: (next: Waypoint[]) => Promise<void>
    onSaveAnchor: (end: 'from' | 'to', side: AnchorSide | null) => Promise<void>
    onSaveProps: (patch: {
      style?: EdgeStyle | null
      from_marker?: EdgeMarker | null
      to_marker?: EdgeMarker | null
    }) => Promise<void>
  },
  'frame'
>

const HANDLES = [
  { id: 'top', position: Position.Top },
  { id: 'right', position: Position.Right },
  { id: 'bottom', position: Position.Bottom },
  { id: 'left', position: Position.Left },
]

/**
 * One diagram frame as a React Flow node. The header is the drag handle
 * (`dragHandle` on the node targets it), so the body stays free for text
 * selection and link clicks. Connections start from the four side dots; while
 * a connection is being dragged from another node, an invisible full-size
 * target handle covers the card so the drop can land anywhere on it.
 *
 * Double-clicking the card (handled by the parent's `onNodeDoubleClick`, which
 * flips `data.editing`) swaps the static title/body for inputs and reveals a
 * colour/task/delete row directly on the card — there is no separate editor
 * panel. Field drafts reset from the server frame each time `editing` turns
 * true (the "adjust state during render on a prop change" pattern, matching
 * `FrameEdgeView`'s `seenWaypoints`), so a previous unsaved edit never leaks
 * into the next edit session.
 *
 * Shared by every flowchart/ERD shape (`FrameNode`/`ProcessNode`/
 * `DecisionNode`/`StartEndNode`/`EntityNode` below): identical content,
 * editing, and connection behavior — the only differences are `shapeClass`,
 * an extra class name that gives the card its silhouette (rectangle/diamond/
 * oval/entity box) in CSS, and the optional `renderBody` override (used only
 * by `EntityNode`, to render `Frame.body` as hard-line-broken markdown in a
 * monospace field-list style — see arch.md §5). A single implementation keeps the
 * mutation wiring (`data.onSave*`) in one place rather than duplicated per
 * shape.
 */
function FrameCardNode({
  id,
  data,
  shapeClass,
  renderBody,
}: NodeProps<FrameNodeType> & {
  shapeClass?: string
  renderBody?: (body: string) => React.ReactNode
}) {
  const f = data.frame
  const editing = data.editing
  const connection = useConnection()
  const isConnectTarget = connection.inProgress && connection.fromNode.id !== id

  const [titleDraft, setTitleDraft] = useState(f.title)
  const [bodyDraft, setBodyDraft] = useState(f.body ?? '')
  const [taskDraft, setTaskDraft] = useState(
    f.task_id !== null ? String(f.task_id) : '',
  )
  const [taskError, setTaskError] = useState<string | null>(null)
  // An empty body shows no description box at all — just an "add description"
  // button that mounts the textarea (task 448). Reset per edit session like the
  // drafts below, so a frame whose body is still empty next time starts
  // collapsed again rather than remembering a stray click.
  const [bodyOpen, setBodyOpen] = useState((f.body ?? '') !== '')
  // Focusing the title input on the *create* path (task 448) can't just be
  // React's `autoFocus`. A freshly-created React Flow node renders with
  // `visibility: hidden` until React Flow has measured it — two animation
  // frames, in browser QA — and `focus()` on a hidden element is a silent
  // no-op, so both `autoFocus` and a one-shot effect land on nothing and
  // `document.activeElement` stays `<body>`. Retry across frames until the
  // node is visible and the focus actually takes, bounded so a node that
  // never becomes focusable can't spin forever.
  const focusTitle = useCallback((el: HTMLInputElement | null) => {
    if (!el) return
    const card = el.closest('.frame')
    let tries = 0
    const attempt = () => {
      if (!el.isConnected || document.activeElement === el) return
      // Don't steal the caret back if the user has already moved into the
      // body textarea or another field on this card.
      if (card && card.contains(document.activeElement)) return
      el.focus()
      if (document.activeElement !== el && ++tries < 30) {
        requestAnimationFrame(attempt)
      }
    }
    attempt()
  }, [])

  const [wasEditing, setWasEditing] = useState(editing)
  if (editing !== wasEditing) {
    setWasEditing(editing)
    if (editing) {
      setTitleDraft(f.title)
      setBodyDraft(f.body ?? '')
      setTaskDraft(f.task_id !== null ? String(f.task_id) : '')
      setTaskError(null)
      setBodyOpen((f.body ?? '') !== '')
    }
  }

  // Save failures surface on the shared canvas error banner (`saveFrame` in
  // the parent already calls `showError`); these `.catch(() => {})`s only
  // swallow the resulting promise rejection so it doesn't also log as an
  // unhandled rejection. `saveTask` is the one exception — it shows the
  // error inline next to the field, matching the old panel's behavior for a
  // validation error the user needs to fix (e.g. an unknown task id).
  function saveTitle() {
    const next = titleDraft.trim()
    if (next === '' || next === f.title) {
      setTitleDraft(f.title)
      return
    }
    data.onSaveTitle(next).catch(() => {})
  }

  function saveBody() {
    if (bodyDraft !== (f.body ?? '')) data.onSaveBody(bodyDraft).catch(() => {})
  }

  function saveTask() {
    const trimmed = taskDraft.trim()
    if (trimmed === '') {
      setTaskError(null)
      if (f.task_id !== null) data.onSaveTask(null).catch(() => {})
      return
    }
    const taskId = Number(trimmed)
    if (!Number.isInteger(taskId) || taskId <= 0) {
      setTaskError('task id must be a positive number')
      return
    }
    setTaskError(null)
    data.onSaveTask(taskId).catch((e: unknown) => {
      setTaskError(e instanceof Error ? e.message : String(e))
    })
  }

  // Handles are siblings of the card, not children: the card clips its
  // content (overflow + corner clip-path), which would swallow the half-
  // outside connection dots.
  return (
    <>
      <div
        className={
          'frame' +
          (shapeClass ? ' ' + shapeClass : '') +
          (data.selected ? ' selected' : '') +
          (editing ? ' editing' : '')
        }
        style={{
          width: editing ? undefined : f.w,
          minHeight: f.h,
          borderColor: f.color ?? undefined,
        }}
      >
        <div className="frame-header">
          {editing ? (
            <input
              className="frame-title-input nodrag"
              ref={focusTitle}
              placeholder="frame title"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') setTitleDraft(f.title)
              }}
            />
          ) : (
            <span
              className={'frame-title' + (f.title.trim() === '' ? ' muted' : '')}
            >
              {/* New frames are created untitled (task 448), so read mode needs
                  something to show for a frame the user never named. */}
              {f.title.trim() === '' ? 'untitled' : <Markdown text={f.title} />}
            </span>
          )}
          <span className="frame-id muted">#{f.id}</span>
          {editing && (
            <button
              className="frame-done nodrag"
              title="done editing"
              onClick={data.onDone}
            >
              done
            </button>
          )}
        </div>
        {editing ? (
          bodyOpen ? (
            <textarea
              className="frame-body-input"
              rows={4}
              // Focus follows the click that opened it. Only ever true for a
              // body that started empty, so an edit session on a frame that
              // already has a body still lands focus on the title input above.
              autoFocus={(f.body ?? '') === ''}
              value={bodyDraft}
              onChange={(e) => setBodyDraft(e.target.value)}
              onBlur={saveBody}
            />
          ) : (
            <button
              className="frame-add-body nodrag"
              onClick={() => setBodyOpen(true)}
            >
              + description
            </button>
          )
        ) : (
          f.body && (
            <div className="frame-body">
              {renderBody ? renderBody(f.body) : <Markdown text={f.body} />}
            </div>
          )
        )}
        {editing ? (
          <div className="frame-edit-fields">
            <p className="frame-field">
              colour{' '}
              <input
                type="color"
                value={f.color ?? '#0e1722'}
                onChange={(e) => data.onSaveColor(e.target.value).catch(() => {})}
              />
              <button onClick={() => data.onSaveColor(null).catch(() => {})}>
                clear
              </button>
            </p>
            <p className="frame-field">
              task{' '}
              <input
                type="text"
                className="task-input"
                value={taskDraft}
                placeholder="task id"
                onChange={(e) => setTaskDraft(e.target.value)}
                onBlur={saveTask}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
              />
              {f.task_id !== null && (
                <a href={`#/projects/${data.projectId}/tasks/${f.task_id}`}>
                  open #{f.task_id}
                </a>
              )}
              {taskError && <span className="error">{taskError}</span>}
            </p>
            <ConfirmDelete
              label="delete frame"
              message="Deletes this frame and the edges touching it."
              onDelete={data.onDelete}
            />
          </div>
        ) : (
          <div className="frame-foot muted">
            {f.task_id !== null && (
              <span className="badge">task #{f.task_id}</span>
            )}
            {f.author && <span>{f.author}</span>}
          </div>
        )}
      </div>
      {HANDLES.map((h) => (
        <Handle key={h.id} id={h.id} type="source" position={h.position} />
      ))}
      {isConnectTarget && (
        <Handle
          id="drop"
          type="target"
          position={Position.Top}
          className="frame-drop-handle"
        />
      )}
    </>
  )
}

/** The generic card — a `storyboard`-type board, or any frame with
 *  `shape === null` (Must #6 regression guard: byte-identical to the
 *  pre-flowchart rendering, since `shapeClass` is unset). */
function FrameNode(props: NodeProps<FrameNodeType>) {
  return <FrameCardNode {...props} />
}

/** Flowchart "process" step: a plain rectangle (sharper corners than the
 *  generic card's cut-corner styling). */
function ProcessNode(props: NodeProps<FrameNodeType>) {
  return <FrameCardNode {...props} shapeClass="frame-process" />
}

/** Flowchart "decision" branch: a diamond. */
function DecisionNode(props: NodeProps<FrameNodeType>) {
  return <FrameCardNode {...props} shapeClass="frame-decision" />
}

/** Flowchart "start/end" terminator: a rounded oval/pill. */
function StartEndNode(props: NodeProps<FrameNodeType>) {
  return <FrameCardNode {...props} shapeClass="frame-start-end" />
}

/** ERD "entity" shape: same card/editing/connection behavior as every other
 *  shape, but the body renders through `Markdown` in `breaks` mode and in a
 *  tighter monospace field-list style (`.frame-entity-body`).
 *
 *  Before task 492 this split `body` on newlines and emitted one plain-text
 *  `<li>` per line, so an attribute could never carry emphasis, `code`, or a
 *  markdown table — an ERD written with tables (one row per column, the shape
 *  an agent naturally generates) rendered as a wall of literal `|` pipes.
 *  `remark-breaks` is what makes markdown safe here: a single newline stays a
 *  visible line break, so the older line-per-attribute convention still reads
 *  as one attribute per line instead of collapsing into a prose blob the way a
 *  generic card's soft breaks do. Still presentation only — `Frame.body`
 *  remains a plain string with no parsed/validated structure. */
function EntityNode(props: NodeProps<FrameNodeType>) {
  return (
    <FrameCardNode
      {...props}
      shapeClass="frame-entity"
      renderBody={(body) => (
        <div className="frame-entity-body">
          <Markdown text={body} breaks />
        </div>
      )}
    />
  )
}

/** Brainstorm "central topic": the mind-map hub the ideas branch off. Same
 *  card behavior as every other shape; the bold pill styling is CSS only, and
 *  nothing enforces one-central-per-board — a brainstorm board is as freeform
 *  as every other diagram. */
function CentralNode(props: NodeProps<FrameNodeType>) {
  return <FrameCardNode {...props} shapeClass="frame-central" />
}

/** Brainstorm "idea": a branch node hanging off the central topic. */
function IdeaNode(props: NodeProps<FrameNodeType>) {
  return <FrameCardNode {...props} shapeClass="frame-idea" />
}

// --- mesa task 854's shapes ---
//
// Same story as every shape above: one shared `FrameCardNode`, distinguished
// only by `shapeClass` (and, for `weak_entity`, the same `renderBody` override
// `entity` uses — a weak entity is an entity, so its attribute list should read
// identically). Which CSS technique each silhouette uses, and why, is in
// App.css beside the rules; the constraint they all obey is that a silhouette
// that would clip the header (title + `#id` badge) is drawn as an oversized
// `::before` backdrop behind an unclipped card, never as a `clip-path` on the
// card itself — the lesson `decision` and `central` were fixed by.

/** Storyboard "scene": the shot card a storyboard is made of — a plain card
 *  with a film-strip band, so it reads as a frame of film beside a `note`. */
function SceneNode(props: NodeProps<FrameNodeType>) {
  return <FrameCardNode {...props} shapeClass="frame-scene" />
}

/** "Note": a folded-corner sticky annotation. The one shape two board types
 *  share (storyboard and brainstorm) — commentary belongs to neither type
 *  system. */
function NoteNode(props: NodeProps<FrameNodeType>) {
  return <FrameCardNode {...props} shapeClass="frame-note" />
}

/** Flowchart "data" (ANSI input/output): a parallelogram. */
function DataNode(props: NodeProps<FrameNodeType>) {
  return <FrameCardNode {...props} shapeClass="frame-data" />
}

/** Flowchart "document": a rectangle with a wavy bottom edge. */
function DocumentNode(props: NodeProps<FrameNodeType>) {
  return <FrameCardNode {...props} shapeClass="frame-document" />
}

/** Flowchart "database": a cylinder. */
function DatabaseNode(props: NodeProps<FrameNodeType>) {
  return <FrameCardNode {...props} shapeClass="frame-database" />
}

/** Flowchart "predefined process" (a call into a named subroutine): a
 *  rectangle with a double bar down each side. */
function PredefinedProcessNode(props: NodeProps<FrameNodeType>) {
  return <FrameCardNode {...props} shapeClass="frame-predefined-process" />
}

/** ERD "weak entity": an entity whose identity depends on another, drawn with
 *  the double border the notation gives it. Reuses `EntityNode`'s attribute
 *  list treatment verbatim — a weak entity's attributes are read exactly like
 *  an entity's. */
function WeakEntityNode(props: NodeProps<FrameNodeType>) {
  return (
    <FrameCardNode
      {...props}
      shapeClass="frame-weak-entity"
      renderBody={(body) => (
        <div className="frame-entity-body">
          <Markdown text={body} breaks />
        </div>
      )}
    />
  )
}

/** ERD "relationship" (Chen notation): a diamond, drawn the same backdrop way
 *  the flowchart `decision` diamond is. */
function RelationshipNode(props: NodeProps<FrameNodeType>) {
  return <FrameCardNode {...props} shapeClass="frame-relationship" />
}

/** ERD "attribute" (Chen notation): an ellipse. */
function AttributeNode(props: NodeProps<FrameNodeType>) {
  return <FrameCardNode {...props} shapeClass="frame-attribute" />
}

type Rect = { x: number; y: number; w: number; h: number }
type Point = { x: number; y: number }
type Anchor = Point & { position: Position }
const cx = (r: Rect) => r.x + r.w / 2
const cy = (r: Rect) => r.y + r.h / 2

/** The four connection-dot positions of a frame: the side midpoints, matching
 *  the rendered HANDLES (top/right/bottom/left). */
const anchorsOf = (r: Rect): Anchor[] => [
  { x: cx(r), y: r.y, position: Position.Top },
  { x: r.x + r.w, y: cy(r), position: Position.Right },
  { x: cx(r), y: r.y + r.h, position: Position.Bottom },
  { x: r.x, y: cy(r), position: Position.Left },
]

/** The anchor of `r` nearest to `toward`, so the edge endpoint sits exactly on
 *  a connection dot and re-snaps as the frames move. Its `position` tells the
 *  curved path which way to bow the control points. */
function nearestAnchor(r: Rect, toward: Point): Anchor {
  let best = anchorsOf(r)[0]
  let bestD = Infinity
  for (const a of anchorsOf(r)) {
    const d = (a.x - toward.x) ** 2 + (a.y - toward.y) ** 2
    if (d < bestD) {
      bestD = d
      best = a
    }
  }
  return best
}

/** The anchor of `r` at a specific locked side — used instead of
 *  `nearestAnchor` once an endpoint is locked, so it holds that side
 *  regardless of the other frame's (or a waypoint's) position. */
function lockedAnchor(r: Rect, side: Position): Anchor {
  return anchorsOf(r).find((a) => a.position === side)!
}

/** Outward unit normal for each side, used to push an anchor-lock dot a few
 *  px past the frame border — see `ANCHOR_LOCK_OFFSET`. */
const OUTWARD_NORMAL: Record<Position, Point> = {
  [Position.Top]: { x: 0, y: -1 },
  [Position.Right]: { x: 1, y: 0 },
  [Position.Bottom]: { x: 0, y: 1 },
  [Position.Left]: { x: -1, y: 0 },
}

/** How far an anchor-lock dot sits past the exact `anchorsOf` point (which is
 *  also where `FrameNode`'s always-on `HANDLES` connection dots render) —
 *  enough that a click lands unambiguously on the lock dot, not the
 *  connection `Handle` underneath it (ADR #7). Checked concretely (mesa task
 *  353): the connection `Handle`'s hit box is 22px square centered on the
 *  anchor point (11px radius) and this dot is 10px (5px radius), so the
 *  offset must clear 11 + 5 = 16px to leave zero overlap — 14px still left a
 *  2px band where the `Handle` (not this dot) won the hit-test. */
const ANCHOR_LOCK_OFFSET = 18

/** An anchor position offset outward along its own side's normal, for
 *  rendering (never for path routing — routing always uses the exact
 *  `anchorsOf` point). */
function offsetOutward(a: Anchor, dist: number): Point {
  const n = OUTWARD_NORMAL[a.position]
  return { x: a.x + n.x * dist, y: a.y + n.y * dist }
}

/** Margin of the invisible hover "halo" around a frame, in flow units — wide
 *  enough to fully contain the anchor-lock dots (which sit `ANCHOR_LOCK_OFFSET`
 *  outside the frame border) with a few px to spare. */
const ANCHOR_HALO_MARGIN = ANCHOR_LOCK_OFFSET + 8

/** Four non-overlapping bars tiling the padding ring just outside a frame's
 *  bounds — never over the frame body itself, so the frame's own drag/click
 *  behavior is untouched. Checked empirically (mesa task 353): a single fixed
 *  hide-delay on the path/dot handlers alone isn't enough — a stepped
 *  mouse-move toward a dot on the frame's *far* side (opposite the edge's
 *  live anchor) crossed bare canvas for 100+ px and dropped hover before
 *  arriving, so that dot was unreachable. This halo gives the pointer one
 *  continuous hoverable surface all the way around the frame, so it can
 *  travel from any anchor-lock dot to any other on the same frame (or from
 *  the edge path, which always lands exactly on this ring's inner edge)
 *  without crossing open canvas. */
function haloBars(r: Rect, margin: number): { x: number; y: number; w: number; h: number }[] {
  return [
    { x: r.x - margin, y: r.y - margin, w: r.w + 2 * margin, h: margin }, // top
    { x: r.x - margin, y: r.y + r.h, w: r.w + 2 * margin, h: margin }, // bottom
    { x: r.x - margin, y: r.y, w: margin, h: r.h }, // left
    { x: r.x + r.w, y: r.y, w: margin, h: r.h }, // right
  ]
}

/** Converts an ordered point list into a smooth SVG path via Catmull-Rom
 *  splines (tension 1/6) turned into cubic beziers, so a routed connector
 *  curves through each waypoint instead of meeting it at a sharp corner.
 *  Falls back to a straight `L` segment when there aren't enough points to
 *  fit a spline through. */
function smoothPath(points: Point[]): string {
  if (points.length < 3) {
    return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
  }
  let d = `M ${points[0].x} ${points[0].y}`
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i === 0 ? 0 : i - 1]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[i + 2 < points.length ? i + 2 : points.length - 1]
    const cp1x = p1.x + (p2.x - p0.x) / 6
    const cp1y = p1.y + (p2.y - p0.y) / 6
    const cp2x = p2.x - (p3.x - p1.x) / 6
    const cp2y = p2.y - (p3.y - p1.y) / 6
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`
  }
  return d
}

/** The point at half the total arc length along an ordered point list —
 *  used to place an edge's label on the actual route (rather than the
 *  straight-line midpoint of just its two endpoints, which drifts off a
 *  bent/curved path). For a 2-point list this is exactly the segment
 *  midpoint, matching the plain-bezier case's original behavior. */
function midpointOfPolyline(points: Point[]): Point {
  const segments: number[] = []
  let total = 0
  for (let i = 0; i < points.length - 1; i++) {
    const dx = points[i + 1].x - points[i].x
    const dy = points[i + 1].y - points[i].y
    const d = Math.sqrt(dx * dx + dy * dy)
    segments.push(d)
    total += d
  }
  let remaining = total / 2
  for (let i = 0; i < segments.length; i++) {
    if (remaining <= segments[i] || i === segments.length - 1) {
      const t = segments[i] === 0 ? 0 : remaining / segments[i]
      return {
        x: points[i].x + (points[i + 1].x - points[i].x) * t,
        y: points[i].y + (points[i + 1].y - points[i].y) * t,
      }
    }
    remaining -= segments[i]
  }
  return points[0]
}

/**
 * Builds the drawn path for an edge, threading through 0..N stored waypoints
 * in order (index 0 nearest `from`, the last nearest `to`). `anchors` is the
 * full ordered point list actually used to draw the route — `[start,
 * ...waypoints, end]` in absolute canvas coordinates — the seam the next
 * story's drag handles / click-to-insert hit-testing builds on. `mid` is
 * where the edge label sits, always a point on (or, for the spline case,
 * essentially on) the drawn path.
 *
 * Empty case: byte-identical to the original plain-bezier rendering — both
 * endpoint anchors snap toward the *other* frame's centre and a single
 * `getBezierPath` call draws the curve. Unless `dupOffset` is non-zero (this
 * edge shares both endpoint frames with at least one other edge), in which
 * case the drawn path bows perpendicular to the start-end line by that many
 * px instead — see `parallelOffsets` — so parallel connectors between the
 * same two frames no longer draw pixel-identical (and so click/select the
 * wrong one, mesa task 412). `anchors` stays `[start, end]` regardless, so
 * waypoint insertion/handle rendering (which read `anchors`) are unaffected.
 *
 * Non-empty case: the start anchor snaps toward the first waypoint and the
 * end anchor toward the last one, and the route is a smooth spline through
 * every anchor in order. Already-diverging (real waypoints exist), so
 * `dupOffset` is not applied here.
 */
function buildRoutedPath(
  from: Rect,
  to: Rect,
  waypoints: Point[],
  fromAnchor: AnchorSide | null,
  toAnchor: AnchorSide | null,
  dupOffset = 0,
): { path: string; anchors: Point[]; mid: Point } {
  if (waypoints.length === 0) {
    const start = fromAnchor
      ? lockedAnchor(from, fromAnchor as Position)
      : nearestAnchor(from, { x: cx(to), y: cy(to) })
    const end = toAnchor
      ? lockedAnchor(to, toAnchor as Position)
      : nearestAnchor(to, { x: cx(from), y: cy(from) })
    const anchors = [start, end]
    if (dupOffset !== 0) {
      const dx = end.x - start.x
      const dy = end.y - start.y
      const len = Math.hypot(dx, dy) || 1
      const bow = {
        x: (start.x + end.x) / 2 - (dy / len) * dupOffset,
        y: (start.y + end.y) / 2 + (dx / len) * dupOffset,
      }
      return { path: smoothPath([start, bow, end]), anchors, mid: bow }
    }
    const [path] = getBezierPath({
      sourceX: start.x,
      sourceY: start.y,
      sourcePosition: start.position,
      targetX: end.x,
      targetY: end.y,
      targetPosition: end.position,
    })
    return { path, anchors, mid: midpointOfPolyline(anchors) }
  }

  const start = fromAnchor
    ? lockedAnchor(from, fromAnchor as Position)
    : nearestAnchor(from, waypoints[0])
  const end = toAnchor
    ? lockedAnchor(to, toAnchor as Position)
    : nearestAnchor(to, waypoints[waypoints.length - 1])
  const anchors: Point[] = [start, ...waypoints, end]
  const path = smoothPath(anchors)
  return { path, anchors, mid: midpointOfPolyline(anchors) }
}

/** Squared distance from `p` to the segment `a`-`b` — used to find which
 *  segment of a routed connector a click landed nearest, to decide where in
 *  the waypoint list a newly-inserted point belongs. Squared (no sqrt) since
 *  only relative comparison is needed. */
function distToSegmentSq(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  let t = lenSq === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  const cx2 = a.x + t * dx
  const cy2 = a.y + t * dy
  return (p.x - cx2) ** 2 + (p.y - cy2) ** 2
}

/** Perpendicular bow (px) to draw each edge's plain-bezier path with, keyed
 *  by edge id — zero unless the edge shares both endpoint frames (in either
 *  direction) with at least one sibling edge, in which case siblings fan out
 *  evenly around the straight line so they no longer draw pixel-identical
 *  (mesa task 412: pixel-identical paths meant only the topmost of a pair was
 *  ever clickable, so the other could never be selected/edited/deleted). */
function parallelOffsets(
  edges: { id: number; from_frame: number; to_frame: number }[],
): Map<number, number> {
  const SPACING = 40
  const groups = new Map<string, number[]>()
  for (const e of edges) {
    const key =
      e.from_frame < e.to_frame
        ? `${e.from_frame}:${e.to_frame}`
        : `${e.to_frame}:${e.from_frame}`
    const ids = groups.get(key) ?? []
    ids.push(e.id)
    groups.set(key, ids)
  }
  const offsets = new Map<number, number>()
  for (const ids of groups.values()) {
    if (ids.length < 2) continue
    ids.forEach((id, i) => offsets.set(id, (i - (ids.length - 1) / 2) * SPACING))
  }
  return offsets
}

/**
 * A "floating" edge drawn anchor-to-anchor: each endpoint snaps to whichever
 * of the two frames' four side dots is nearest the other frame's centre
 * (positions + sizes measured by React Flow), ignoring which handle the
 * connection was dragged from — the stored edge has no handle, only from/to
 * frames. The label (inline-editable, hover-revealed delete) sits on the
 * midpoint of the visible segment.
 */
function FrameEdgeView({
  id,
  source,
  target,
  data,
  markerEnd,
}: EdgeProps<FrameEdgeType>) {
  const sourceNode = useInternalNode(source)
  const targetNode = useInternalNode(target)
  const { screenToFlowPosition } = useReactFlow()
  // Local optimistic override of the waypoint list: live while dragging (so
  // the connector follows the pointer before the PATCH round-trips) and also
  // set immediately on insert/remove so the change is "visible immediately"
  // (req. 3), mirroring nodes' own local drag state (`onNodeDragStop`'s
  // pattern via `useNodesState`) — edges otherwise derive straight from the
  // server view with no local state. Cleared once the server view's own
  // `data.waypoints` changes (the reseed), by which point it already matches.
  const [localWaypoints, setLocalWaypoints] = useState<Waypoint[] | null>(
    null,
  )
  // Reset the override the moment the server view's own `data.waypoints`
  // reference changes (the reseed) — a render-time adjustment (React's
  // "adjusting state when a prop changes" pattern), not an effect, since by
  // then the override and the fresh prop already agree on the value.
  const [seenWaypoints, setSeenWaypoints] = useState(data?.waypoints)
  if (data && data.waypoints !== seenWaypoints) {
    setSeenWaypoints(data.waypoints)
    setLocalWaypoints(null)
  }
  // Anchor-lock dots (8, 4 per endpoint) are quiet by default and revealed on
  // hover only — local state, not `EdgeProps.selected` (this canvas has no
  // `onEdgesChange`/`useEdgesState`, so an edge's `selected` never round-trips;
  // see arch.md §6). Set from both the wide hit-target path and each dot
  // itself (below), so hover survives the path-to-dot handoff.
  const [hovered, setHovered] = useState(false)
  // The connector-properties popover (line style + both end markers, mesa task
  // 854), opened from the label cluster's ⋮ button. Local like `hovered`: it is
  // view state on one edge, and this canvas has no edge selection to hang it
  // off (see the `hovered` note above).
  const [propsOpen, setPropsOpen] = useState(false)
  // A same-side dot sits right next to the path (inside its 28px hit band),
  // so path->dot is a seamless handoff there — but the *other* 3 sides per
  // endpoint can be 100+px away across empty canvas, well outside that band.
  // Hiding on the bare `onMouseLeave` would unmount those far dots mid-travel,
  // before the pointer ever reaches them, making the opposite side
  // unreachable (checked empirically: a stepped mouse-move toward a far dot
  // dropped to 0 dots one step off the path and never recovered). A short
  // hide delay — cleared by any enter, on path or dot — bridges that gap
  // (standard hover-intent debounce), without new cross-component wiring.
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
  }, [])
  function showAnchorDots() {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current)
      hideTimer.current = null
    }
    setHovered(true)
  }
  function scheduleHideAnchorDots() {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null
      setHovered(false)
    }, 250)
  }

  if (!sourceNode || !targetNode || !data) return null
  const rect = (n: typeof sourceNode): Rect => ({
    x: n.internals.positionAbsolute.x,
    y: n.internals.positionAbsolute.y,
    w: n.measured.width ?? 0,
    h: n.measured.height ?? 0,
  })
  const from = rect(sourceNode)
  const to = rect(targetNode)
  const waypoints = localWaypoints ?? data.waypoints
  const { path, anchors, mid } = buildRoutedPath(
    from,
    to,
    waypoints,
    data.fromAnchor,
    data.toAnchor,
    data.dupOffset,
  )
  const isEmpty = !(data.label && data.label.trim())
  // Connector properties (mesa task 854). Each falls back to exactly what this
  // canvas drew before the feature when the stored value is `null`: no
  // dasharray, no start marker, and — at the `to` end — React Flow's own
  // `markerEnd` (the closed cyan arrowhead the parent still puts on the edge
  // object). `EdgeMarker::None` is the *explicit* "draw nothing" answer and is
  // a different thing from that `null`, so it clears the arrowhead.
  const strokeDasharray = dashArrayFor(data.style)
  const startMarker =
    data.fromMarker === null ? undefined : markerUrl(data.fromMarker)
  const endMarker =
    data.toMarker === null ? markerEnd : markerUrl(data.toMarker)

  const commit = (next: Waypoint[]) => {
    setLocalWaypoints(next)
    data.onSaveWaypoints(next).catch(() => setLocalWaypoints(null))
  }

  /** Double-click on the connector's path inserts a waypoint at the click
   *  point, positioned in the ordered list by whichever existing segment (of
   *  `anchors`, already computed above — never recomputed) the click landed
   *  nearest. */
  function insertWaypoint(e: React.MouseEvent) {
    e.stopPropagation()
    const p = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    const point = { x: Math.round(p.x), y: Math.round(p.y) }
    let bestIndex = 0
    let bestD = Infinity
    for (let i = 0; i < anchors.length - 1; i++) {
      const d = distToSegmentSq(point, anchors[i], anchors[i + 1])
      if (d < bestD) {
        bestD = d
        bestIndex = i
      }
    }
    const next = [...waypoints]
    next.splice(bestIndex, 0, point)
    commit(next)
  }

  /** Drags waypoint `index`: local state follows the pointer via window-level
   *  listeners (the handle itself may leave the small hit target mid-drag),
   *  then PATCHes the rounded final position on release — matching
   *  `onNodeDragStop`'s local-drag-then-PATCH-then-reseed pattern. */
  function startDrag(e: React.PointerEvent, index: number) {
    e.stopPropagation()
    e.preventDefault()
    const onMove = (ev: PointerEvent) => {
      const p = screenToFlowPosition({ x: ev.clientX, y: ev.clientY })
      const next = waypoints.map((w, i) => (i === index ? p : w))
      setLocalWaypoints(next)
    }
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const p = screenToFlowPosition({ x: ev.clientX, y: ev.clientY })
      const rounded = { x: Math.round(p.x), y: Math.round(p.y) }
      const next = waypoints.map((w, i) => (i === index ? rounded : w))
      commit(next)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  /** Removes waypoint `index`, restoring the plain auto-routed bezier once
   *  the array is empty again. */
  function removeWaypoint(e: React.MouseEvent | React.PointerEvent, index: number) {
    e.stopPropagation()
    commit(waypoints.filter((_, i) => i !== index))
  }

  /** Click on an anchor-lock dot: clicking the already-locked (filled) side
   *  unlocks that endpoint (back to floating/`nearestAnchor`); clicking any
   *  other (outline) side locks — or directly re-locks, no separate unlock
   *  step — to that side. The two endpoints are fully independent. */
  const clickAnchorDot = (e: React.MouseEvent, end: 'from' | 'to', side: Position) => {
    e.stopPropagation()
    const current = end === 'from' ? data.fromAnchor : data.toAnchor
    const isLocked = current !== null && current === (side as unknown as AnchorSide)
    data.onSaveAnchor(end, isLocked ? null : (side as unknown as AnchorSide)).catch(() => {})
  }

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerStart={startMarker}
        markerEnd={endMarker}
        style={strokeDasharray ? { strokeDasharray } : undefined}
      />
      {/* Wider invisible hit target for click-to-insert — the visible path
          (BaseEdge's `.react-flow__edge-path`) is only 2px wide, too thin to
          reliably double-click (mesa task 334: 16px was still too thin). */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={28}
        style={{ pointerEvents: 'stroke', cursor: 'copy' }}
        onDoubleClick={insertWaypoint}
        onMouseEnter={showAnchorDots}
        onMouseLeave={scheduleHideAnchorDots}
      />
      <EdgeLabelRenderer>
        <div
          className={
            'edge-label nodrag nopan' +
            (isEmpty ? ' empty' : '') +
            (propsOpen ? ' open' : '')
          }
          style={{
            transform: `translate(-50%, -50%) translate(${mid.x}px, ${mid.y}px)`,
          }}
        >
          <div className="edge-label-row">
            <InlineEdit
              className="edge-label-text"
              value={data.label ?? ''}
              placeholder="label"
              onSave={data.onSaveLabel}
            />
            {/* Connector properties live behind this toggle rather than in
                their own panel: the label cluster is already the edge's one
                selected affordance (label, delete, and the anchor-lock dots
                hanging off the same hover), so a second surface would only
                compete with it. */}
            <button
              className="edge-props-toggle"
              title="connector style and end markers"
              onClick={() => setPropsOpen((o) => !o)}
            >
              ⋮
            </button>
            <button
              className="edge-del"
              title="delete edge"
              onClick={data.onDelete}
            >
              ✕
            </button>
          </div>
          {propsOpen && (
            <div className="edge-props">
              <label>
                <span className="edge-props-name">line</span>
                <select
                  value={data.style ?? ''}
                  onChange={(e) =>
                    data
                      .onSaveProps({
                        style: (e.target.value || null) as EdgeStyle | null,
                      })
                      .catch(() => {})
                  }
                >
                  <option value="">default</option>
                  {EDGE_STYLES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              {/* Only the markers this board's `diagram_type` accepts — the ERD
                  cardinality family is erd-only server-side, so offering it on
                  a flowchart would just 422 the PATCH. */}
              {(
                [
                  ['start', 'from_marker', data.fromMarker],
                  ['end', 'to_marker', data.toMarker],
                ] as const
              ).map(([label, field, current]) => (
                <label key={field}>
                  <span className="edge-props-name">{label}</span>
                  <select
                    value={current ?? ''}
                    onChange={(e) =>
                      data
                        .onSaveProps({
                          [field]: (e.target.value || null) as EdgeMarker | null,
                        })
                        .catch(() => {})
                    }
                  >
                    <option value="">default</option>
                    {markersForType(data.diagramType).map((m) => (
                      <option key={m} value={m}>
                        {MARKER_LABELS[m]}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          )}
        </div>
        {anchors.slice(1, -1).map((w, i) => (
          <div
            key={i}
            className="waypoint-handle nodrag nopan"
            title="drag to move · double-click to remove"
            style={{
              transform: `translate(-50%, -50%) translate(${w.x}px, ${w.y}px)`,
            }}
            onPointerDown={(e) => startDrag(e, i)}
            onDoubleClick={(e) => removeWaypoint(e, i)}
          />
        ))}
        {hovered &&
          (
            [
              ['from', from, data.fromAnchor] as const,
              ['to', to, data.toAnchor] as const,
            ] as const
          ).flatMap(([end, rect, lockedSide]) => [
            ...haloBars(rect, ANCHOR_HALO_MARGIN).map((bar, i) => (
              <div
                key={`${end}-halo-${i}`}
                className="anchor-lock-halo nodrag nopan"
                style={{
                  transform: `translate(${bar.x}px, ${bar.y}px)`,
                  width: bar.w,
                  height: bar.h,
                }}
                onMouseEnter={showAnchorDots}
                onMouseLeave={scheduleHideAnchorDots}
              />
            )),
            ...anchorsOf(rect).map((a) => {
              const locked =
                lockedSide !== null && lockedSide === (a.position as unknown as AnchorSide)
              const p = offsetOutward(a, ANCHOR_LOCK_OFFSET)
              return (
                <div
                  key={`${end}-${a.position}`}
                  className={
                    'anchor-lock-dot nodrag nopan' + (locked ? ' locked' : '')
                  }
                  title={`lock ${end} endpoint to ${a.position}`}
                  style={{
                    transform: `translate(-50%, -50%) translate(${p.x}px, ${p.y}px)`,
                  }}
                  onMouseEnter={showAnchorDots}
                  onMouseLeave={scheduleHideAnchorDots}
                  onClick={(e) => clickAnchorDot(e, end, a.position)}
                />
              )
            }),
          ])}
      </EdgeLabelRenderer>
    </>
  )
}

/**
 * Preview line while dragging a new connection from a side dot. React
 * Flow's default picks the arrival side as a fixed opposite of whichever dot
 * was grabbed (e.g. always "left" from a "right" handle), regardless of
 * where the cursor actually is — dragging perpendicular to that axis makes
 * the curve loop back on itself instead of bowing smoothly toward the
 * cursor. This picks the arrival side from the cursor's dominant direction
 * instead, matching how a real edge's floating anchor (`nearestAnchor`)
 * would resolve once the drop lands on an actual frame.
 */
function FrameConnectionLine({
  fromX,
  fromY,
  fromPosition,
  toX,
  toY,
}: ConnectionLineComponentProps) {
  const dx = toX - fromX
  const dy = toY - fromY
  const toPosition =
    Math.abs(dx) >= Math.abs(dy)
      ? dx >= 0
        ? Position.Left
        : Position.Right
      : dy >= 0
        ? Position.Top
        : Position.Bottom
  const [path] = getBezierPath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: fromPosition,
    targetX: toX,
    targetY: toY,
    targetPosition: toPosition,
  })
  return <path d={path} fill="none" className="react-flow__connection-path" />
}

/**
 * The `<marker>` elements every connector's endpoints reference by id (mesa
 * task 854). React Flow's built-in `MarkerType` only knows two arrowheads, so
 * everything past `arrow` — the hollow arrow, circle, diamond, and the whole
 * ERD crow's-foot cardinality family — has to be defined here.
 *
 * Three things make these work at both ends of a path:
 * - **`orient="auto-start-reverse"`** means one definition serves both
 *   `marker-start` and `marker-end`: at the start it is flipped, so it points
 *   back down the path rather than into the frame it is attached to. That is
 *   why there is one marker per value rather than a start/end pair.
 * - **`context-stroke`** for fill/stroke picks up the *edge's* stroke colour
 *   rather than a hardcoded one, so a marker can never disagree with the line
 *   it terminates. The hollow shapes fill with the canvas panel colour so the
 *   line behind them does not show through.
 * - **`markerUnits="userSpaceOnUse"`** keeps every glyph one size in flow
 *   coordinates instead of scaling with the 2px stroke.
 *
 * Rendered once per canvas into its own zero-size `<svg>`: a `url(#id)`
 * reference resolves document-wide, so the markers do not need to live inside
 * React Flow's own SVG (which we do not own).
 *
 * Geometry convention: +x runs along the path *toward* the endpoint, so x=0 is
 * back down the line and the right edge of each viewBox sits on the frame.
 */
function EdgeMarkerDefs() {
  const line = { stroke: 'context-stroke', strokeWidth: 1.6, fill: 'none' }
  const hollow = { stroke: 'context-stroke', strokeWidth: 1.2, fill: 'var(--panel)' }
  const solid = { fill: 'context-stroke', stroke: 'none' }
  /** A crow's foot: three lines fanning from one point back on the line out to
   *  the frame — the "many" glyph, shared by three cardinality markers. */
  const crow = (x0: number, x1: number) => (
    <path d={`M${x1},0 L${x0},6 L${x1},12 M${x0},6 L${x1},6`} style={line} />
  )
  const marker = (
    id: string,
    width: number,
    children: React.ReactNode,
  ) => (
    <marker
      key={id}
      id={`mesa-edge-marker-${id}`}
      viewBox={`0 0 ${width} 12`}
      markerWidth={width}
      markerHeight={12}
      refX={width}
      refY={6}
      orient="auto-start-reverse"
      markerUnits="userSpaceOnUse"
    >
      {children}
    </marker>
  )
  return (
    <svg className="edge-marker-defs" aria-hidden="true">
      <defs>
        {marker('arrow', 12, <path d="M0,1 L12,6 L0,11 z" style={solid} />)}
        {marker(
          'hollow_arrow',
          12,
          <path d="M0.6,1.4 L11.4,6 L0.6,10.6 z" style={hollow} />,
        )}
        {marker('circle', 12, <circle cx={6} cy={6} r={4.6} style={hollow} />)}
        {marker(
          'diamond',
          14,
          <path d="M0.6,6 L7,1.4 L13.4,6 L7,10.6 z" style={hollow} />,
        )}
        {marker('crows_foot', 14, crow(0, 14))}
        {marker('one', 12, <path d="M8,1 L8,11" style={line} />)}
        {marker(
          'zero_or_one',
          20,
          <>
            <circle cx={5} cy={6} r={4} style={hollow} />
            <path d="M15,1 L15,11" style={line} />
          </>,
        )}
        {marker(
          'one_or_many',
          20,
          <>
            <path d="M2,1 L2,11" style={line} />
            {crow(6, 20)}
          </>,
        )}
        {marker(
          'zero_or_many',
          22,
          <>
            <circle cx={5} cy={6} r={4} style={hollow} />
            {crow(10, 22)}
          </>,
        )}
      </defs>
    </svg>
  )
}

/**
 * The silhouette drawn beside a palette row's name (mesa task 868).
 *
 * One flat 40×24 line drawing per shape — the same *idea* as the node's CSS
 * silhouette in App.css, redrawn in SVG rather than reusing it: a node's
 * silhouette is built from card-sized rules (oversized `::before` backdrops,
 * clip-paths sized to a 240×140 card) that do not survive being shrunk to a
 * palette row, and a picture of the shape is all a palette row needs.
 */
function ShapeIcon({ shape }: { shape: FrameShape | null }) {
  const s = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 }
  const body = () => {
    switch (shape) {
      // The generic card: a rectangle with the cut corner the plain frame draws.
      case null:
        return <path d="M2,2 H30 L38,10 V22 H2 Z" style={s} />
      case 'process':
        return <rect x="2" y="3" width="36" height="18" style={s} />
      case 'decision':
      case 'relationship':
        return <path d="M20,2 L38,12 L20,22 L2,12 Z" style={s} />
      case 'start_end':
        return <rect x="2" y="3" width="36" height="18" rx="9" style={s} />
      case 'data':
        return <path d="M8,3 H38 L32,21 H2 Z" style={s} />
      case 'document':
        return (
          <path
            d="M2,3 H38 V17 Q32,23 20,18 Q8,13 2,19 Z"
            style={s}
          />
        )
      case 'database':
        return (
          <>
            <path d="M4,6 V18 Q4,22 20,22 Q36,22 36,18 V6" style={s} />
            <ellipse cx="20" cy="6" rx="16" ry="4" style={s} />
          </>
        )
      case 'predefined_process':
        return (
          <>
            <rect x="2" y="3" width="36" height="18" style={s} />
            <path d="M8,3 V21 M32,3 V21" style={s} />
          </>
        )
      // An entity is a table: a titled box. A weak entity is the same box
      // doubled, which is the notation's own way of saying it.
      case 'entity':
        return (
          <>
            <rect x="2" y="3" width="36" height="18" style={s} />
            <path d="M2,9 H38" style={s} />
          </>
        )
      case 'weak_entity':
        return (
          <>
            <rect x="2" y="3" width="36" height="18" style={s} />
            <rect x="5" y="6" width="30" height="12" style={s} />
          </>
        )
      case 'attribute':
        return <ellipse cx="20" cy="12" rx="18" ry="9" style={s} />
      case 'central':
        return (
          <rect
            x="2"
            y="4"
            width="36"
            height="16"
            rx="8"
            style={{ ...s, fill: 'currentColor', opacity: 0.35 }}
          />
        )
      case 'idea':
        return (
          <>
            <rect x="14" y="4" width="24" height="16" rx="8" style={s} />
            <path d="M2,12 H14" style={s} />
          </>
        )
      // A scene is a frame of film: the card plus its perforation band.
      case 'scene':
        return (
          <>
            <rect x="2" y="3" width="36" height="18" style={s} />
            <path d="M2,7 H38" style={s} />
            <path d="M6,3 V7 M12,3 V7 M18,3 V7 M24,3 V7 M30,3 V7" style={s} />
          </>
        )
      // A note is a sticky with its corner turned up.
      case 'note':
        return (
          <>
            <path d="M4,3 H36 V15 L30,21 H4 Z" style={s} />
            <path d="M36,15 H30 V21" style={s} />
          </>
        )
    }
  }
  return (
    <svg viewBox="0 0 40 24" className="shape-rail-icon" aria-hidden="true">
      {body()}
    </svg>
  )
}

/**
 * The shape palette: the toolbar down the left of the diagram space (mesa task
 * 868). One row per shape this board type accepts, each showing the silhouette
 * and the name, each **draggable onto the canvas** to place that frame where it
 * is dropped — and still clickable, which is the create-at-a-default-spot
 * gesture the old wrapped button cluster in the canvas panel offered.
 *
 * A row is a `<button>` so it stays keyboard-reachable and activates on Enter;
 * drag is HTML5 drag-and-drop (a pointer gesture layered on top), not a
 * replacement for the click.
 */
function ShapePalette({
  diagramType,
  onAdd,
}: {
  diagramType: DiagramType
  onAdd: (shape: FrameShape | null) => void
}) {
  return (
    <div className="shape-rail" aria-label="Shapes">
      <span className="shape-rail-title muted">shapes</span>
      {paletteItems(diagramType).map((item) => (
        <button
          key={item.key}
          className="shape-rail-item"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(SHAPE_DRAG_MIME, encodeShapeDrag(item.shape))
            e.dataTransfer.effectAllowed = 'copy'
          }}
          onClick={() => onAdd(item.shape)}
          title={`drag a ${item.label} onto the canvas, or click to add one`}
        >
          <ShapeIcon shape={item.shape} />
          <span className="shape-rail-name">{item.label}</span>
        </button>
      ))}
    </div>
  )
}

const nodeTypes = {
  frame: FrameNode,
  process: ProcessNode,
  decision: DecisionNode,
  start_end: StartEndNode,
  entity: EntityNode,
  central: CentralNode,
  idea: IdeaNode,
  scene: SceneNode,
  note: NoteNode,
  data: DataNode,
  document: DocumentNode,
  database: DatabaseNode,
  predefined_process: PredefinedProcessNode,
  weak_entity: WeakEntityNode,
  relationship: RelationshipNode,
  attribute: AttributeNode,
}
const edgeTypes = { frame: FrameEdgeView }

/**
 * The freeform diagram canvas, rendered by React Flow: frames are custom
 * nodes dragged by their header (a PATCH on drop), edges are floating
 * anchor-to-anchor connectors created by dragging between the side handles,
 * and double-clicking a frame edits it in place on the card (title/body/
 * colour/task) — no side panel. Nodes re-derive from the server `view` after
 * every mutation (`onChanged` refetches; the parent owns the fetch), and
 * every mutation is stamped with `author` for the change history. The
 * pan/zoom viewport is browser-local per board (boardView.ts); the parent
 * keys this component by board id, so a board switch remounts onto that
 * board's saved viewport.
 */
export function DiagramCanvas({
  view,
  projectId,
  author,
  onChanged,
}: {
  view: DiagramView
  projectId: number
  author: string
  onChanged: () => void
}) {
  const diagramId = view.diagram.id
  const [selectedId, setSelectedId] = useState<number | null>(null)
  // The frame currently in on-card inline edit mode (entered by double-click),
  // distinct from `selectedId` (highlight + Cmd+D target) — a card can be
  // selected without being edited, never edited without being selected (set
  // together on double-click).
  const [editingId, setEditingId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Expanded mode: the canvas takes over the whole window (CSS fixes the root to
  // the viewport). Purely a view-layer toggle, never persisted on the board.
  const [expanded, setExpanded] = useState(false)
  // Flow direction the "auto layout" button lays frames out in. A view-layer
  // preference, not persisted — matches `expanded` above.
  const [layoutDirection, setLayoutDirection] =
    useState<LayoutDirection>('vertical')

  const showError = useCallback((e: unknown) => {
    setError(e instanceof Error ? e.message : String(e))
  }, [])

  /** Save one edited field on a frame. Mirrors `editEdgeLabel` below: resolves
   *  to refetch, surfaces a rejection on the shared error banner. Used by the
   *  inline edit form on the card — there is no separate save step, each
   *  field commits on blur/change. */
  const saveFrame = useCallback(
    (id: number, patch: FramePatch) =>
      updateFrame(id, patch, author).then(
        () => {
          setError(null)
          onChanged()
        },
        (e) => {
          showError(e)
          throw e
        },
      ),
    [author, onChanged, showError],
  )

  const removeFrame = useCallback(
    (id: number) =>
      deleteFrame(id, author).then(
        () => {
          setError(null)
          setEditingId(null)
          setSelectedId(null)
          onChanged()
        },
        (e) => {
          showError(e)
          throw e
        },
      ),
    [author, onChanged, showError],
  )

  // Nodes live in React Flow state so drags are smooth (React Flow applies the
  // position changes locally); the server view re-seeds them after every
  // refetch. A drop PATCHes x/y, so the refetch lands on the same coordinates
  // and nothing snaps back.
  const toNodes = useCallback(
    (frames: Frame[], selected: number | null, editing: number | null): FrameNodeType[] =>
      frames.map((f) => ({
        id: String(f.id),
        // `storyboard`-type boards (and any pre-357 frame): `shape` is always
        // null, so this always resolves to `'frame'` — byte-identical to the
        // pre-flowchart behavior (Must #6 regression guard). A flowchart
        // board's frames key off their own persisted shape instead.
        type: (f.shape ?? 'frame') as FrameNodeKind,
        position: { x: f.x, y: f.y },
        data: {
          frame: f,
          selected: selected === f.id,
          editing: editing === f.id,
          projectId,
          onSaveTitle: (next: string) => saveFrame(f.id, { title: next }),
          onSaveBody: (next: string) =>
            saveFrame(f.id, { body: next === '' ? null : next }),
          onSaveColor: (next: string | null) => saveFrame(f.id, { color: next }),
          onSaveTask: (next: number | null) => saveFrame(f.id, { task_id: next }),
          onDelete: () => removeFrame(f.id),
          onDone: () => setEditingId(null),
        },
        dragHandle: '.frame-header',
      })),
    [projectId, saveFrame, removeFrame],
  )
  const [nodes, setNodes, onNodesChange] = useNodesState<FrameNodeType>(
    toNodes(view.frames, null, null),
  )
  useEffect(() => {
    setNodes(toNodes(view.frames, selectedId, editingId))
  }, [view.frames, selectedId, editingId, setNodes, toNodes])

  const removeEdge = useCallback(
    (id: number) => {
      deleteEdge(id, author).then(() => {
        setError(null)
        onChanged()
      }, showError)
    },
    [author, onChanged, showError],
  )

  /** Save an edited connector label. Empty string clears it (null). Returns the
   *  promise so InlineEdit can surface a save error / stay open on failure. */
  const editEdgeLabel = useCallback(
    (id: number, next: string) =>
      updateEdge(id, { label: next === '' ? null : next }, author).then(
        () => {
          setError(null)
          onChanged()
        },
        (e) => {
          showError(e)
          throw e
        },
      ),
    [author, onChanged, showError],
  )

  /** Save a reordered/added/removed waypoint list. Mirrors `editEdgeLabel`
   *  above. `FrameEdgeView` keeps its own local optimistic copy while
   *  dragging/inserting/removing; this only persists it. */
  const editEdgeWaypoints = useCallback(
    (id: number, next: Waypoint[]) =>
      updateEdge(id, { waypoints: next }, author).then(
        () => {
          setError(null)
          onChanged()
        },
        (e) => {
          showError(e)
          throw e
        },
      ),
    [author, onChanged, showError],
  )

  /** Lock/unlock one edge endpoint to a fixed side. Mirrors `editEdgeLabel`
   *  above. A lock click is a single discrete action (no in-progress drag
   *  phase like waypoints), so there's no local optimistic copy to keep. */
  const editEdgeAnchor = useCallback(
    (id: number, end: 'from' | 'to', side: AnchorSide | null) =>
      updateEdge(
        id,
        end === 'from' ? { from_anchor: side } : { to_anchor: side },
        author,
      ).then(
        () => {
          setError(null)
          onChanged()
        },
        (e) => {
          showError(e)
          throw e
        },
      ),
    [author, onChanged, showError],
  )

  /** Save one connector property — line style or either end marker (mesa task
   *  854). Mirrors `editEdgeAnchor` above: one discrete choice per call, no
   *  local optimistic copy, and the same three-state contract on the wire
   *  (a `null` clears back to the default, an omitted key is untouched). */
  const editEdgeProps = useCallback(
    (
      id: number,
      patch: {
        style?: EdgeStyle | null
        from_marker?: EdgeMarker | null
        to_marker?: EdgeMarker | null
      },
    ) =>
      updateEdge(id, patch, author).then(
        () => {
          setError(null)
          onChanged()
        },
        (e) => {
          showError(e)
          throw e
        },
      ),
    [author, onChanged, showError],
  )

  // Edges derive straight from the server view — no local edge state to sync.
  const edges: FrameEdgeType[] = useMemo(() => {
    const dupOffsets = parallelOffsets(view.edges)
    return view.edges.map((e) => ({
      id: String(e.id),
      source: String(e.from_frame),
      target: String(e.to_frame),
      type: 'frame' as const,
      data: {
        label: e.label,
        waypoints: e.waypoints,
        fromAnchor: e.from_anchor,
        toAnchor: e.to_anchor,
        dupOffset: dupOffsets.get(e.id) ?? 0,
        style: e.style,
        fromMarker: e.from_marker,
        toMarker: e.to_marker,
        diagramType: view.diagram.diagram_type,
        onSaveLabel: (next: string) => editEdgeLabel(e.id, next),
        onDelete: () => removeEdge(e.id),
        onSaveWaypoints: (next: Waypoint[]) => editEdgeWaypoints(e.id, next),
        onSaveAnchor: (end: 'from' | 'to', side: AnchorSide | null) =>
          editEdgeAnchor(e.id, end, side),
        onSaveProps: (patch) => editEdgeProps(e.id, patch),
      },
      // Left in place unconditionally so an edge with `to_marker: null` keeps
      // drawing exactly this arrowhead (`FrameEdgeView` falls back to the
      // resolved `markerEnd` prop); an edge that names its own `to_marker`
      // ignores it and references one of `EdgeMarkerDefs`' markers instead.
      markerEnd: { type: MarkerType.ArrowClosed, color: '#00e5ff' },
    }))
  }, [
    view.edges,
    view.diagram.diagram_type,
    editEdgeLabel,
    removeEdge,
    editEdgeWaypoints,
    editEdgeAnchor,
    editEdgeProps,
  ])

  // The shape set this board's diagram_type allows, and — for the gestures
  // that don't offer an explicit shape choice (pane double-click,
  // drag-a-connection-to-empty-canvas) — the shape to default to so those
  // still work on flowchart/erd boards instead of drawing the `Store`
  // validation error a `shape: null` create now hits there. Since task 854 a
  // `storyboard` board's first entry is an explicit `null` (the generic card)
  // rather than an empty set, so its quick-create gestures still mint exactly
  // the plain card they always did.
  const boardShapes = SHAPES_FOR_TYPE[view.diagram.diagram_type]
  const defaultShape = boardShapes[0] ?? undefined

  /** Creates the frame untitled and opens it for editing, so the user lands in
   *  a focused, empty title input and just types (task 448) — rather than
   *  having to select-all over a placeholder "New frame" string first. An
   *  untitled frame renders as a muted "untitled" until named. */
  function addFrame(shape?: FrameShape, pos?: { x: number; y: number }) {
    const n = view.frames.length
    createFrame(diagramId, {
      title: '',
      x: pos ? Math.round(pos.x) : 48 + (n % 6) * 28,
      y: pos ? Math.round(pos.y) : 48 + (n % 6) * 28,
      author,
      shape,
    }).then((f) => {
      setError(null)
      onChanged()
      setSelectedId(f.id)
      setEditingId(f.id)
    }, showError)
  }

  /** Cmd+D/Ctrl+D target: creates a copy of `frame` offset down-right so it
   *  doesn't sit exactly on top of the original. Does not carry over the
   *  linked task — a duplicate shouldn't silently point two frames at the
   *  same task without the user choosing to. Carries over the source
   *  frame's own shape (rather than `defaultShape`) so duplicating e.g. a
   *  decision node yields another decision node, not always the board's
   *  first shape. */
  const duplicateFrame = useCallback(
    (frame: Frame) => {
      createFrame(diagramId, {
        title: frame.title,
        body: frame.body ?? undefined,
        x: frame.x + 32,
        y: frame.y + 32,
        w: frame.w,
        h: frame.h,
        color: frame.color ?? undefined,
        author,
        shape: frame.shape ?? undefined,
      }).then((f) => {
        setError(null)
        onChanged()
        setSelectedId(f.id)
      }, showError)
    },
    [diagramId, author, onChanged, showError],
  )

  // React Flow has no onPaneDoubleClick — capture the instance via onInit and
  // gate on the event target so this only fires on the empty pane background,
  // never bubbling up from a node/edge double-click (waypoint insert/remove).
  const rfInstance = useRef<ReactFlowInstance<FrameNodeType, FrameEdgeType> | null>(
    null,
  )
  function onPaneDoubleClick(e: React.MouseEvent) {
    if (!(e.target as HTMLElement).classList.contains('react-flow__pane')) return
    const inst = rfInstance.current
    if (!inst) return
    addFrame(defaultShape, inst.screenToFlowPosition({ x: e.clientX, y: e.clientY }))
  }

  /** A palette row dropped on the canvas creates that frame centred on the
   *  drop point (mesa task 868). The payload is re-checked against this
   *  board's own shape set (`decodeShapeDrag`) — a drop can carry anything,
   *  and a shape this board type rejects would be a 422 on a gesture the user
   *  cannot undo. Anything else is not a shape drop and is left alone, so a
   *  file dragged onto the canvas still behaves as it did. */
  function onPaneDragOver(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes(SHAPE_DRAG_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  function onPaneDrop(e: React.DragEvent) {
    const drop = decodeShapeDrag(
      e.dataTransfer.getData(SHAPE_DRAG_MIME),
      view.diagram.diagram_type,
    )
    const inst = rfInstance.current
    if (!drop || !inst) return
    e.preventDefault()
    addFrame(
      drop.shape ?? undefined,
      dropPosition(inst.screenToFlowPosition({ x: e.clientX, y: e.clientY })),
    )
  }

  function onNodeDragStop(_e: unknown, node: FrameNodeType) {
    const f = view.frames.find((fr) => String(fr.id) === node.id)
    const x = Math.round(node.position.x)
    const y = Math.round(node.position.y)
    // A click on the drag handle also fires dragStop; only a real move PATCHes.
    if (f && f.x === x && f.y === y) return
    updateFrame(Number(node.id), { x, y }, author).then(() => {
      setError(null)
      onChanged()
    }, showError)
  }

  /** Repositions every frame into ranked layers flowing in `layoutDirection`
   *  (see layout.ts) and PATCHes each frame whose position actually moved. */
  function autoLayout() {
    const positions = layoutFrames(view.frames, view.edges, layoutDirection)
    const moves = view.frames
      .map((f) => ({ f, p: positions.get(f.id)! }))
      .filter(({ f, p }) => f.x !== p.x || f.y !== p.y)
    Promise.all(
      moves.map(({ f, p }) => updateFrame(f.id, { x: p.x, y: p.y }, author)),
    ).then(() => {
      setError(null)
      onChanged()
    }, showError)
  }

  function onConnect(c: Connection) {
    if (c.source === c.target) return // self-edges are rejected server-side
    createEdge(diagramId, {
      from_frame: Number(c.source),
      to_frame: Number(c.target),
      author,
    }).then(() => {
      setError(null)
      onChanged()
    }, showError)
  }

  /** Dragging a connection from a frame's side dot and releasing over empty
   *  canvas (not onto another frame's drop target) creates a new frame at
   *  the release point and wires an edge from the source frame to it — the
   *  standard React Flow "add node on connection drop" affordance. Dropping
   *  on a frame still takes the `onConnect` path above and only makes an
   *  edge; `connectionState.isValid` is truthy exactly when the drag ended
   *  on a valid target handle, so this only fires on the empty-space case. */
  function onConnectEnd(
    event: MouseEvent | TouchEvent,
    connectionState: FinalConnectionState,
  ) {
    const inst = rfInstance.current
    if (connectionState.isValid || !connectionState.fromNode || !inst) return
    const point = 'changedTouches' in event ? event.changedTouches[0] : event
    const pos = inst.screenToFlowPosition({ x: point.clientX, y: point.clientY })
    const fromId = connectionState.fromNode.id
    createFrame(diagramId, {
      title: '',
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      author,
      shape: defaultShape,
    }).then((f) => {
      setError(null)
      onChanged()
      setSelectedId(f.id)
      setEditingId(f.id)
      createEdge(diagramId, {
        from_frame: Number(fromId),
        to_frame: f.id,
        author,
      }).then(() => onChanged(), showError)
    }, showError)
  }

  // Pan/zoom is browser-local view state, keyed by board (boardView.ts): the
  // saved {tx, ty, scale} maps 1:1 onto React Flow's {x, y, zoom}. Loaded once
  // per mount (the parent remounts per board); saved on every move end.
  const [defaultViewport] = useState<Viewport>(() => {
    const saved = loadBoardView(diagramId)
    return saved
      ? { x: saved.tx, y: saved.ty, zoom: saved.scale }
      : { x: 0, y: 0, zoom: 1 }
  })
  function onMoveEnd(_e: unknown, vp: Viewport) {
    saveBoardView(diagramId, { tx: vp.x, ty: vp.y, scale: vp.zoom })
  }

  // Escape leaves expanded (whole-window) mode — the usual way out of a takeover
  // view. Only bound while expanded so it never swallows Escape elsewhere.
  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  // Escape also leaves a card's inline edit mode — the same "usual way out"
  // as expanded mode above. Only bound while editing so it never swallows
  // Escape elsewhere (e.g. a waypoint drag).
  useEffect(() => {
    if (editingId === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEditingId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editingId])

  // Cmd+D (Ctrl+D off-mac) duplicates the selected frame. Skipped while focus
  // is in a text field (title/body/task-id inputs) so it doesn't fire
  // mid-edit; preventDefault suppresses the browser's own bookmark shortcut.
  useEffect(() => {
    if (selectedId === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'd' || !(e.metaKey || e.ctrlKey)) return
      const target = e.target as HTMLElement
      if (target.closest('input, textarea, [contenteditable="true"]')) return
      e.preventDefault()
      const frame = view.frames.find((f) => f.id === selectedId)
      if (frame) duplicateFrame(frame)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, view.frames, duplicateFrame])

  return (
    <div className={`diagram${expanded ? ' expanded' : ''}`}>
      {/* The shape toolbar, outside the canvas so it never covers the drawing
          and never eats a pan gesture (mesa task 868). */}
      <ShapePalette
        diagramType={view.diagram.diagram_type}
        onAdd={(shape) => addFrame(shape ?? undefined)}
      />
      <div
        className="diagram-viewport"
        onDragOver={onPaneDragOver}
        onDrop={onPaneDrop}
      >
        {/* Endpoint marker definitions, once per canvas. A `url(#id)` reference
            resolves document-wide, so these need not (and cannot) live inside
            React Flow's own SVG. */}
        <EdgeMarkerDefs />
        <ReactFlow
          colorMode="dark"
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onInit={(inst) => {
            rfInstance.current = inst
          }}
          onNodesChange={onNodesChange}
          onNodeDragStop={onNodeDragStop}
          onNodeClick={(_e, node) => {
            const id = Number(node.id)
            setSelectedId(id)
            if (editingId !== null && editingId !== id) setEditingId(null)
          }}
          onNodeDoubleClick={(_e, node) => {
            const id = Number(node.id)
            setSelectedId(id)
            setEditingId(id)
          }}
          onPaneClick={() => {
            setSelectedId(null)
            setEditingId(null)
          }}
          onDoubleClick={onPaneDoubleClick}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          connectionMode={ConnectionMode.Loose}
          connectionLineComponent={FrameConnectionLine}
          defaultViewport={defaultViewport}
          onMoveEnd={onMoveEnd}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          // Double-click is now the waypoint-insert gesture on a connector
          // path (and delete-waypoint on a handle) — React Flow's built-in
          // double-click-to-zoom (d3-zoom, a native listener that fires ahead
          // of React's synthetic handlers) would otherwise fight it.
          zoomOnDoubleClick={false}
          // Deletion stays behind the explicit controls (editor panel / edge ✕),
          // never a stray keypress — matching the rest of the app.
          deleteKeyCode={null}
          nodesFocusable={false}
          edgesFocusable={false}
        >
          <Background
            variant={BackgroundVariant.Lines}
            gap={32}
            color="rgba(0, 229, 255, 0.05)"
          />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable />
          <Panel position="top-left" className="canvas-controls">
            {/* The add-a-shape affordance is no longer here: since mesa task
                868 it is the palette rail down the left of the diagram space
                (`ShapePalette`), which names each shape *and* draws it. What
                stays in this cluster is the canvas-wide actions. */}
            <button onClick={autoLayout} title="Arrange frames by flow direction">
              auto layout
            </button>
            <button
              onClick={() =>
                setLayoutDirection((d) =>
                  d === 'vertical' ? 'horizontal' : 'vertical',
                )
              }
              title="Flow direction for auto layout"
            >
              {layoutDirection === 'vertical' ? '↓ vertical' : '→ horizontal'}
            </button>
            {/* Two hints, one per pointer type, swapped in CSS at the phone
                tier (App.css) rather than by a second `isPhone()` call — the
                gestures differ, not just the wording. See docs/mobile.md,
                "The canvas gesture model". */}
            <span className="canvas-hint muted">
              drag a header to move · drag a side dot to connect ·
              double-click a card to edit
            </span>
            <span className="canvas-hint-touch muted">
              drag to pan · pinch to zoom · drag a header to move · double-tap
              to edit
            </span>
            {error && <span className="error">{error}</span>}
          </Panel>
          <Panel position="top-right">
            <button
              className={`canvas-expand${expanded ? ' active' : ''}`}
              onClick={() => setExpanded((x) => !x)}
              title={
                expanded
                  ? 'Collapse the canvas (Esc)'
                  : 'Expand the canvas to fill the window'
              }
            >
              {expanded ? 'collapse' : 'expand'}
            </button>
          </Panel>
        </ReactFlow>
      </div>
    </div>
  )
}
