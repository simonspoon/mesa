import { useCallback, useEffect, useMemo, useState } from 'react'
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
  getStraightPath,
  useConnection,
  useInternalNode,
  useNodesState,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
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
import type { Frame } from './types/Frame'
import type { StoryboardView } from './types/StoryboardView'

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
    onSaveLabel: (next: string) => Promise<void>
    onDelete: () => void
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
const cx = (r: Rect) => r.x + r.w / 2
const cy = (r: Rect) => r.y + r.h / 2

/** Point where the line from `from`'s centre meets `to`'s rectangle border, so
 *  the arrowhead lands on the box edge instead of behind it. */
function borderPoint(from: Rect, to: Rect): { x: number; y: number } {
  const dx = cx(to) - cx(from)
  const dy = cy(to) - cy(from)
  if (dx === 0 && dy === 0) return { x: cx(to), y: cy(to) }
  const sx = dx !== 0 ? to.w / 2 / Math.abs(dx) : Infinity
  const sy = dy !== 0 ? to.h / 2 / Math.abs(dy) : Infinity
  const s = Math.min(sx, sy)
  return { x: cx(to) - dx * s, y: cy(to) - dy * s }
}

/**
 * A "floating" edge: drawn border-to-border between the two frames' rendered
 * boxes (positions + sizes measured by React Flow), ignoring which handle the
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
  if (!sourceNode || !targetNode || !data) return null
  const rect = (n: typeof sourceNode): Rect => ({
    x: n.internals.positionAbsolute.x,
    y: n.internals.positionAbsolute.y,
    w: n.measured.width ?? 0,
    h: n.measured.height ?? 0,
  })
  const from = rect(sourceNode)
  const to = rect(targetNode)
  const start = borderPoint(to, from)
  const end = borderPoint(from, to)
  const [path] = getStraightPath({
    sourceX: start.x,
    sourceY: start.y,
    targetX: end.x,
    targetY: end.y,
  })
  const isEmpty = !(data.label && data.label.trim())
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        <div
          className={'edge-label nodrag nopan' + (isEmpty ? ' empty' : '')}
          style={{
            transform: `translate(-50%, -50%) translate(${
              (start.x + end.x) / 2
            }px, ${(start.y + end.y) / 2}px)`,
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
      </EdgeLabelRenderer>
    </>
  )
}

const nodeTypes = { frame: FrameNode }
const edgeTypes = { frame: FrameEdgeView }

/**
 * The freeform storyboard canvas, rendered by React Flow: frames are custom
 * nodes dragged by their header (a PATCH on drop), edges are floating
 * border-to-border connectors created by dragging between the side handles,
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
          onSaveLabel: (next: string) => editEdgeLabel(e.id, next),
          onDelete: () => removeEdge(e.id),
        },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#00e5ff' },
      })),
    [view.edges, editEdgeLabel, removeEdge],
  )

  function addFrame() {
    const n = view.frames.length
    createFrame(storyboardId, {
      title: 'New frame',
      x: 48 + (n % 6) * 28,
      y: 48 + (n % 6) * 28,
      author,
    }).then((f) => {
      setError(null)
      onChanged()
      setSelectedId(f.id)
    }, showError)
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
          onNodesChange={onNodesChange}
          onNodeDragStop={onNodeDragStop}
          onNodeClick={(_e, node) => setSelectedId(Number(node.id))}
          onPaneClick={() => setSelectedId(null)}
          onConnect={onConnect}
          connectionMode={ConnectionMode.Loose}
          defaultViewport={defaultViewport}
          onMoveEnd={onMoveEnd}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
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
            <button onClick={addFrame}>add frame</button>
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
