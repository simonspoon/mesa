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
} from './api'
import { loadBoardView, saveBoardView } from './boardView'
import { ConfirmDelete } from './components/ConfirmDelete'
import { InlineEdit } from './components/InlineEdit'
import { Markdown } from './components/Markdown'
import { layoutFrames, type LayoutDirection } from './layout'
import type { Frame } from './types/Frame'
import type { StoryboardView } from './types/StoryboardView'
import type { Waypoint } from './types/Waypoint'

const MIN_ZOOM = 0.25
const MAX_ZOOM = 3

/** Node payload: the server frame plus whether the editor has it selected
 *  (selection is owned by this component, not React Flow's click-select, so
 *  the editor panel and the highlight can never disagree). */
type FrameNodeType = Node<{ frame: Frame; selected: boolean }, 'frame'>

/** Edge payload: the server label plus the mutation callbacks the label
 *  controls need. Callbacks ride in `data` so the custom edge stays a plain
 *  presentational component. */
type FrameEdgeType = Edge<
  {
    label: string | null
    waypoints: Waypoint[]
    onSaveLabel: (next: string) => Promise<void>
    onDelete: () => void
    onSaveWaypoints: (next: Waypoint[]) => Promise<void>
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
 */
function FrameNode({ id, data }: NodeProps<FrameNodeType>) {
  const f = data.frame
  const connection = useConnection()
  const isConnectTarget = connection.inProgress && connection.fromNode.id !== id
  // Handles are siblings of the card, not children: the card clips its
  // content (overflow + corner clip-path), which would swallow the half-
  // outside connection dots.
  return (
    <>
      <div
        className={'frame' + (data.selected ? ' selected' : '')}
        style={{ width: f.w, minHeight: f.h, borderColor: f.color ?? undefined }}
      >
        <div className="frame-header">
          <span className="frame-title">
            <Markdown text={f.title} />
          </span>
          <span className="frame-id muted">#{f.id}</span>
        </div>
        {f.body && (
          <div className="frame-body">
            <Markdown text={f.body} />
          </div>
        )}
        <div className="frame-foot muted">
          {f.task_id !== null && (
            <span className="badge">task #{f.task_id}</span>
          )}
          {f.author && <span>{f.author}</span>}
        </div>
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
 * `getBezierPath` call draws the curve.
 *
 * Non-empty case: the start anchor snaps toward the first waypoint and the
 * end anchor toward the last one, and the route is a smooth spline through
 * every anchor in order.
 */
function buildRoutedPath(
  from: Rect,
  to: Rect,
  waypoints: Point[],
): { path: string; anchors: Point[]; mid: Point } {
  if (waypoints.length === 0) {
    const start = nearestAnchor(from, { x: cx(to), y: cy(to) })
    const end = nearestAnchor(to, { x: cx(from), y: cy(from) })
    const [path] = getBezierPath({
      sourceX: start.x,
      sourceY: start.y,
      sourcePosition: start.position,
      targetX: end.x,
      targetY: end.y,
      targetPosition: end.position,
    })
    const anchors = [start, end]
    return { path, anchors, mid: midpointOfPolyline(anchors) }
  }

  const start = nearestAnchor(from, waypoints[0])
  const end = nearestAnchor(to, waypoints[waypoints.length - 1])
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
  const { path, anchors, mid } = buildRoutedPath(from, to, waypoints)
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

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} />
      {/* Wider invisible hit target for click-to-insert — the visible path
          (BaseEdge's `.react-flow__edge-path`) is only 2px wide, too thin to
          reliably double-click. */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={16}
        style={{ pointerEvents: 'stroke', cursor: 'copy' }}
        onDoubleClick={insertWaypoint}
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

const nodeTypes = { frame: FrameNode }
const edgeTypes = { frame: FrameEdgeView }

/**
 * The freeform storyboard canvas, rendered by React Flow: frames are custom
 * nodes dragged by their header (a PATCH on drop), edges are floating
 * anchor-to-anchor connectors created by dragging between the side handles,
 * and a right-hand panel edits the selected frame. Nodes re-derive from the
 * server `view` after every mutation (`onChanged` refetches; the parent owns
 * the fetch), and every mutation is stamped with `author` for the change
 * history. The pan/zoom viewport is browser-local per board (boardView.ts);
 * the parent keys this component by board id, so a board switch remounts onto
 * that board's saved viewport.
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

  // Nodes live in React Flow state so drags are smooth (React Flow applies the
  // position changes locally); the server view re-seeds them after every
  // refetch. A drop PATCHes x/y, so the refetch lands on the same coordinates
  // and nothing snaps back.
  const toNodes = useCallback(
    (frames: Frame[], selected: number | null): FrameNodeType[] =>
      frames.map((f) => ({
        id: String(f.id),
        type: 'frame' as const,
        position: { x: f.x, y: f.y },
        data: { frame: f, selected: selected === f.id },
        dragHandle: '.frame-header',
      })),
    [],
  )
  const [nodes, setNodes, onNodesChange] = useNodesState<FrameNodeType>(
    toNodes(view.frames, null),
  )
  useEffect(() => {
    setNodes(toNodes(view.frames, selectedId))
  }, [view.frames, selectedId, setNodes, toNodes])

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

  // Edges derive straight from the server view — no local edge state to sync.
  const edges: FrameEdgeType[] = useMemo(
    () =>
      view.edges.map((e) => ({
        id: String(e.id),
        source: String(e.from_frame),
        target: String(e.to_frame),
        type: 'frame' as const,
        data: {
          label: e.label,
          waypoints: e.waypoints,
          onSaveLabel: (next: string) => editEdgeLabel(e.id, next),
          onDelete: () => removeEdge(e.id),
          onSaveWaypoints: (next: Waypoint[]) => editEdgeWaypoints(e.id, next),
        },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#00e5ff' },
      })),
    [view.edges, editEdgeLabel, removeEdge, editEdgeWaypoints],
  )

  function addFrame(pos?: { x: number; y: number }) {
    const n = view.frames.length
    createFrame(storyboardId, {
      title: 'New frame',
      x: pos ? Math.round(pos.x) : 48 + (n % 6) * 28,
      y: pos ? Math.round(pos.y) : 48 + (n % 6) * 28,
      author,
    }).then((f) => {
      setError(null)
      onChanged()
      setSelectedId(f.id)
    }, showError)
  }

  /** Cmd+D/Ctrl+D target: creates a copy of `frame` offset down-right so it
   *  doesn't sit exactly on top of the original. Does not carry over the
   *  linked task — a duplicate shouldn't silently point two frames at the
   *  same task without the user choosing to. */
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
    addFrame(inst.screenToFlowPosition({ x: e.clientX, y: e.clientY }))
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

  const selected =
    selectedId === null
      ? undefined
      : view.frames.find((f) => f.id === selectedId)

  return (
    <div
      className={`storyboard${selected ? ' has-panel' : ''}${
        expanded ? ' expanded' : ''
      }`}
    >
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
          onNodeClick={(_e, node) => setSelectedId(Number(node.id))}
          onPaneClick={() => setSelectedId(null)}
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
            <button onClick={() => addFrame()}>add frame</button>
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
              drag a header to move · drag a side dot to connect · click to
              edit
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

      {selected && (
        <aside className="side-panel frame-editor">
          <FrameEditor
            key={selected.id}
            frame={selected}
            projectId={projectId}
            author={author}
            onChanged={onChanged}
            onClose={() => setSelectedId(null)}
            onDeleted={() => {
              setSelectedId(null)
              onChanged()
            }}
            onError={showError}
          />
        </aside>
      )}
    </div>
  )
}

/** Edits the selected frame. Keyed by frame id in the parent, so its draft
 *  state resets cleanly when the selection changes. */
function FrameEditor({
  frame,
  projectId,
  author,
  onChanged,
  onClose,
  onDeleted,
  onError,
}: {
  frame: Frame
  projectId: number
  author: string
  onChanged: () => void
  onClose: () => void
  onDeleted: () => void
  onError: (e: unknown) => void
}) {
  const [taskDraft, setTaskDraft] = useState(
    frame.task_id !== null ? String(frame.task_id) : '',
  )
  const [taskError, setTaskError] = useState<string | null>(null)

  function saveTask() {
    const trimmed = taskDraft.trim()
    if (trimmed === '') {
      setTaskError(null)
      updateFrame(frame.id, { task_id: null }, author).then(onChanged, onError)
      return
    }
    const id = Number(trimmed)
    if (!Number.isInteger(id) || id <= 0) {
      setTaskError('task id must be a positive number')
      return
    }
    setTaskError(null)
    updateFrame(frame.id, { task_id: id }, author).then(onChanged, (e) => {
      setTaskError(e instanceof Error ? e.message : String(e))
    })
  }

  return (
    <>
      <p className="panel-head">
        <button className="panel-close" onClick={onClose}>
          ✕
        </button>
      </p>
      <h1>
        <InlineEdit
          value={frame.title}
          onSave={(title) =>
            updateFrame(frame.id, { title }, author).then(onChanged)
          }
        />
      </h1>

      <p className="description">
        <InlineEdit
          value={frame.body ?? ''}
          multiline
          placeholder="no body — click to add"
          onSave={(d) =>
            updateFrame(frame.id, { body: d === '' ? null : d }, author).then(
              onChanged,
            )
          }
        />
      </p>

      <p className="frame-field">
        Colour{' '}
        <input
          type="color"
          value={frame.color ?? '#0e1722'}
          onChange={(e) =>
            updateFrame(frame.id, { color: e.target.value }, author).then(
              onChanged,
              onError,
            )
          }
        />
        <button
          onClick={() =>
            updateFrame(frame.id, { color: null }, author).then(
              onChanged,
              onError,
            )
          }
        >
          clear
        </button>
      </p>

      <p className="frame-field">
        Task{' '}
        <input
          type="text"
          className="task-input"
          value={taskDraft}
          placeholder="task id"
          onChange={(e) => setTaskDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') saveTask()
          }}
        />
        <button onClick={saveTask}>link</button>
        {frame.task_id !== null && (
          <a href={`#/projects/${projectId}/tasks/${frame.task_id}`}>
            open #{frame.task_id}
          </a>
        )}
        {taskError && <span className="error">{taskError}</span>}
      </p>

      <p>
        <ConfirmDelete
          label="delete frame"
          message="Deletes this frame and the edges touching it."
          onDelete={() => deleteFrame(frame.id, author).then(onDeleted)}
        />
      </p>
    </>
  )
}
