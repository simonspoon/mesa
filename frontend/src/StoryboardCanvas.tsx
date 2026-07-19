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
import { layoutFrames, type LayoutDirection } from './layout'
import type { AnchorSide } from './types/AnchorSide'
import type { DiagramType } from './types/DiagramType'
import type { Frame } from './types/Frame'
import type { FrameShape } from './types/FrameShape'
import type { StoryboardView } from './types/StoryboardView'
import type { Waypoint } from './types/Waypoint'

const MIN_ZOOM = 0.25
const MAX_ZOOM = 3

/** Every React Flow node `type` string this canvas can produce: the generic
 *  `'frame'` card (a `storyboard`-type board, or any frame with `shape ===
 *  null`) plus every `FrameShape` value. */
type FrameNodeKind = FrameShape | 'frame'

/** The valid `Frame.shape` set for each `Storyboard.diagram_type`, per
 *  `Store::validate_frame_shape` (src/core/store.rs) — a `storyboard` board
 *  takes no shape (the generic card, `shape: null`), a `flowchart` board
 *  takes exactly one of process/decision/start_end, an `erd` board takes
 *  only entity. Drives both the add-frame picker's offered options (story
 *  360) and the default shape handed to the other frame-creating gestures
 *  below (pane double-click, drag-to-empty-canvas, duplicate) so those keep
 *  working on flowchart/erd boards instead of hitting the `Store` validation
 *  error a `shape: null` create would now draw on those board types. */
const SHAPES_FOR_TYPE: Record<DiagramType, FrameShape[]> = {
  storyboard: [],
  flowchart: ['process', 'decision', 'start_end'],
  erd: ['entity'],
  // `idea` first, deliberately: the first entry doubles as `defaultShape` for
  // the quick-create gestures (pane double-click, drag-to-empty-canvas,
  // Cmd+D), and those should mint a branch idea, not a second hub.
  brainstorm: ['idea', 'central'],
}

/** Display label for each shape's add-frame picker button. */
const SHAPE_LABELS: Record<FrameShape, string> = {
  process: 'process',
  decision: 'decision',
  start_end: 'start/end',
  entity: 'entity',
  central: 'central topic',
  idea: 'idea',
}

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
    onSaveLabel: (next: string) => Promise<void>
    onDelete: () => void
    onSaveWaypoints: (next: Waypoint[]) => Promise<void>
    onSaveAnchor: (end: 'from' | 'to', side: AnchorSide | null) => Promise<void>
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
 * One storyboard frame as a React Flow node. The header is the drag handle
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
 * by `EntityNode` to render `Frame.body` as a distinct attribute list
 * instead of markdown — see arch.md §5). A single implementation keeps the
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
  const [wasEditing, setWasEditing] = useState(editing)
  if (editing !== wasEditing) {
    setWasEditing(editing)
    if (editing) {
      setTitleDraft(f.title)
      setBodyDraft(f.body ?? '')
      setTaskDraft(f.task_id !== null ? String(f.task_id) : '')
      setTaskError(null)
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
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') setTitleDraft(f.title)
              }}
            />
          ) : (
            <span className="frame-title">
              <Markdown text={f.title} />
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
          <textarea
            className="frame-body-input"
            rows={4}
            value={bodyDraft}
            placeholder="no body — type to add"
            onChange={(e) => setBodyDraft(e.target.value)}
            onBlur={saveBody}
          />
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

/** Splits `Frame.body` into its attribute lines: one attribute per non-empty
 *  line, per arch.md §5's line-based convention (no new field, no JSON-in-
 *  `body` structure — `body` stays a plain string round-tripping through the
 *  same `Frame`/`FrameNew`/`FramePatch` shape every other frame uses). */
function attributeLines(body: string): string[] {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/** ERD "entity" shape: same card/editing/connection behavior as every other
 *  shape, but the body renders as a distinct attribute list — one `<li>` per
 *  non-empty line of `Frame.body` — instead of through the `Markdown`
 *  component every other shape uses for its body. Should #13 only asks for a
 *  readable list, not typed/structured attributes, so this is presentation
 *  only: storage is untouched plain text. */
function EntityNode(props: NodeProps<FrameNodeType>) {
  return (
    <FrameCardNode
      {...props}
      shapeClass="frame-entity"
      renderBody={(body) => (
        <ul className="frame-attr-list">
          {attributeLines(body).map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
    />
  )
}

/** Brainstorm "central topic": the mind-map hub the ideas branch off. Same
 *  card behavior as every other shape; the bold pill styling is CSS only, and
 *  nothing enforces one-central-per-board — a brainstorm board is as freeform
 *  as every other storyboard. */
function CentralNode(props: NodeProps<FrameNodeType>) {
  return <FrameCardNode {...props} shapeClass="frame-central" />
}

/** Brainstorm "idea": a branch node hanging off the central topic. */
function IdeaNode(props: NodeProps<FrameNodeType>) {
  return <FrameCardNode {...props} shapeClass="frame-idea" />
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
      <BaseEdge id={id} path={path} markerEnd={markerEnd} />
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
          className={'edge-label nodrag nopan' + (isEmpty ? ' empty' : '')}
          style={{
            transform: `translate(-50%, -50%) translate(${mid.x}px, ${mid.y}px)`,
          }}
        >
          <InlineEdit
            className="edge-label-text"
            value={data.label ?? ''}
            placeholder="label"
            onSave={data.onSaveLabel}
          />
          <button
            className="edge-del"
            title="delete edge"
            onClick={data.onDelete}
          >
            ✕
          </button>
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

const nodeTypes = {
  frame: FrameNode,
  process: ProcessNode,
  decision: DecisionNode,
  start_end: StartEndNode,
  entity: EntityNode,
  central: CentralNode,
  idea: IdeaNode,
}
const edgeTypes = { frame: FrameEdgeView }

/**
 * The freeform storyboard canvas, rendered by React Flow: frames are custom
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
export function StoryboardCanvas({
  view,
  projectId,
  author,
  onChanged,
}: {
  view: StoryboardView
  projectId: number
  author: string
  onChanged: () => void
}) {
  const storyboardId = view.storyboard.id
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
        // Storyboard-type boards (and any pre-357 frame): `shape` is always
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
        onSaveLabel: (next: string) => editEdgeLabel(e.id, next),
        onDelete: () => removeEdge(e.id),
        onSaveWaypoints: (next: Waypoint[]) => editEdgeWaypoints(e.id, next),
        onSaveAnchor: (end: 'from' | 'to', side: AnchorSide | null) =>
          editEdgeAnchor(e.id, end, side),
      },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#00e5ff' },
    }))
  }, [view.edges, editEdgeLabel, removeEdge, editEdgeWaypoints, editEdgeAnchor])

  // The shape set this board's diagram_type allows, and — for the gestures
  // that don't offer an explicit shape choice (pane double-click,
  // drag-a-connection-to-empty-canvas) — the shape to default to so those
  // still work on flowchart/erd boards instead of drawing the `Store`
  // validation error a `shape: null` create now hits there. `[0]` is
  // `undefined` for a `storyboard`-type board (empty array), matching
  // pre-360 behavior exactly.
  const boardShapes = SHAPES_FOR_TYPE[view.storyboard.diagram_type]
  const defaultShape = boardShapes[0]

  function addFrame(shape?: FrameShape, pos?: { x: number; y: number }) {
    const n = view.frames.length
    createFrame(storyboardId, {
      title: 'New frame',
      x: pos ? Math.round(pos.x) : 48 + (n % 6) * 28,
      y: pos ? Math.round(pos.y) : 48 + (n % 6) * 28,
      author,
      shape,
    }).then((f) => {
      setError(null)
      onChanged()
      setSelectedId(f.id)
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
      createFrame(storyboardId, {
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
    [storyboardId, author, onChanged, showError],
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
    createEdge(storyboardId, {
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
    createFrame(storyboardId, {
      title: 'New frame',
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      author,
      shape: defaultShape,
    }).then((f) => {
      setError(null)
      onChanged()
      setSelectedId(f.id)
      createEdge(storyboardId, {
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
    const saved = loadBoardView(storyboardId)
    return saved
      ? { x: saved.tx, y: saved.ty, zoom: saved.scale }
      : { x: 0, y: 0, zoom: 1 }
  })
  function onMoveEnd(_e: unknown, vp: Viewport) {
    saveBoardView(storyboardId, { tx: vp.x, ty: vp.y, scale: vp.zoom })
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
    <div className={`storyboard${expanded ? ' expanded' : ''}`}>
      <div className="storyboard-viewport">
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
            {boardShapes.length === 0 ? (
              // storyboard-type board: exactly today's single button, shape
              // implicitly null — zero UI regression (Must #6).
              <button onClick={() => addFrame()}>add frame</button>
            ) : (
              // flowchart/erd board: a picker offering only the shape set
              // valid for this board's diagram_type (SHAPES_FOR_TYPE above).
              <span className="add-frame-picker">
                {boardShapes.map((shape) => (
                  <button
                    key={shape}
                    onClick={() => addFrame(shape)}
                    title={`add a ${SHAPE_LABELS[shape]} frame`}
                  >
                    + {SHAPE_LABELS[shape]}
                  </button>
                ))}
              </span>
            )}
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
            <span className="canvas-hint muted">
              drag a header to move · drag a side dot to connect ·
              double-click a card to edit
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
