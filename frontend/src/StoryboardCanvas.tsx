import { useRef, useState } from 'react'
import {
  createEdge,
  createFrame,
  deleteEdge,
  deleteFrame,
  updateFrame,
} from './api'
import { ConfirmDelete } from './components/ConfirmDelete'
import { InlineEdit } from './components/InlineEdit'
import type { Frame } from './types/Frame'
import type { StoryboardView } from './types/StoryboardView'

const cx = (f: Frame) => f.x + f.w / 2
const cy = (f: Frame) => f.y + f.h / 2

/** Point where the line from `from`'s centre meets `to`'s rectangle border, so
 *  the arrowhead lands on the box edge instead of behind it. */
function borderPoint(from: Frame, to: Frame): { x: number; y: number } {
  const dx = cx(to) - cx(from)
  const dy = cy(to) - cy(from)
  if (dx === 0 && dy === 0) return { x: cx(to), y: cy(to) }
  const sx = dx !== 0 ? to.w / 2 / Math.abs(dx) : Infinity
  const sy = dy !== 0 ? to.h / 2 / Math.abs(dy) : Infinity
  const s = Math.min(sx, sy)
  return { x: cx(to) - dx * s, y: cy(to) - dy * s }
}

type Drag = {
  id: number
  startX: number
  startY: number
  ox: number
  oy: number
  curX: number
  curY: number
  moved: boolean
}

/**
 * The freeform storyboard canvas: frames are absolutely-positioned cards you
 * drag to reposition (a PATCH on drop), edges are SVG arrows that follow their
 * frames, and a right-hand panel edits the selected frame. "Connect" mode turns
 * clicks into edge creation. Frames render straight from the server `view`; the
 * only local state is a transient drag overlay, so there is no copy to keep in
 * sync. The board does not live-sync; `onChanged` refetches after every
 * mutation (the parent owns the fetch), and every mutation is stamped with
 * `author` for the change history.
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
  const [connectMode, setConnectMode] = useState(false)
  const [connectFrom, setConnectFrom] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Live position of the frame currently being dragged; overlays the server
  // position so the drag is smooth without copying the whole frame list.
  const [dragPos, setDragPos] = useState<{ id: number; x: number; y: number } | null>(
    null,
  )
  const dragRef = useRef<Drag | null>(null)
  const justDragged = useRef(false)

  function showError(e: unknown) {
    setError(e instanceof Error ? e.message : String(e))
  }

  // Frames as placed on screen: server positions, with the dragged one overlaid.
  const placed: Frame[] = view.frames.map((f) =>
    dragPos && dragPos.id === f.id ? { ...f, x: dragPos.x, y: dragPos.y } : f,
  )
  const byId = new Map(placed.map((f) => [f.id, f]))
  const selected = selectedId === null ? undefined : byId.get(selectedId)

  const width = Math.max(1200, ...placed.map((f) => f.x + f.w + 80))
  const height = Math.max(640, ...placed.map((f) => f.y + f.h + 80))

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

  function toggleConnect() {
    setConnectMode((on) => !on)
    setConnectFrom(null)
  }

  function clickFrame(f: Frame) {
    if (justDragged.current) {
      justDragged.current = false
      return
    }
    if (connectMode) {
      if (connectFrom === null) {
        setConnectFrom(f.id)
      } else if (connectFrom === f.id) {
        setConnectFrom(null)
      } else {
        createEdge(storyboardId, {
          from_frame: connectFrom,
          to_frame: f.id,
          author,
        }).then(() => {
          setError(null)
          setConnectFrom(null)
          onChanged()
        }, showError)
      }
      return
    }
    setSelectedId(f.id)
  }

  function onPointerDown(e: React.PointerEvent, f: Frame) {
    // Clear any stale drag flag up front: the browser does not guarantee a
    // click after every drag, so don't rely on clickFrame to reset it.
    justDragged.current = false
    if (e.button !== 0 || connectMode) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = {
      id: f.id,
      startX: e.clientX,
      startY: e.clientY,
      ox: f.x,
      oy: f.y,
      curX: f.x,
      curY: f.y,
      moved: false,
    }
  }

  function onPointerMove(e: React.PointerEvent, f: Frame) {
    const d = dragRef.current
    if (!d || d.id !== f.id) return
    const nx = d.ox + (e.clientX - d.startX)
    const ny = d.oy + (e.clientY - d.startY)
    d.curX = nx
    d.curY = ny
    if (!d.moved && (Math.abs(nx - d.ox) > 3 || Math.abs(ny - d.oy) > 3)) {
      d.moved = true
    }
    setDragPos({ id: f.id, x: nx, y: ny })
  }

  function onPointerUp(e: React.PointerEvent, f: Frame) {
    const d = dragRef.current
    if (!d || d.id !== f.id) return
    dragRef.current = null
    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    if (!d.moved) {
      setDragPos(null)
      return
    }
    justDragged.current = true
    updateFrame(f.id, { x: Math.round(d.curX), y: Math.round(d.curY) }, author).then(
      () => {
        // Keep the overlay at the dropped position until the refetch lands with
        // the same coordinates, so the frame doesn't snap back for a frame.
        setError(null)
        onChanged()
      },
      (err) => {
        // On failure, drop the overlay so the frame reverts to the server position.
        setDragPos(null)
        showError(err)
      },
    )
  }

  function removeEdge(id: number) {
    deleteEdge(id, author).then(() => {
      setError(null)
      onChanged()
    }, showError)
  }

  return (
    <div className={`storyboard${selected ? ' has-panel' : ''}`}>
      <div className="storyboard-toolbar">
        <button onClick={addFrame}>add frame</button>
        <button
          className={connectMode ? 'active' : ''}
          onClick={toggleConnect}
        >
          {connectMode ? 'connecting…' : 'connect'}
        </button>
        <span className="muted">
          {connectMode
            ? connectFrom === null
              ? 'click a frame to start an edge'
              : 'click the target frame'
            : 'drag a frame to move it · click to edit'}
        </span>
        {error && <span className="error">{error}</span>}
      </div>

      <div className="storyboard-scroll">
        <div className="storyboard-canvas" style={{ width, height }}>
          <svg className="edge-layer" width={width} height={height}>
            <defs>
              <marker
                id="arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" />
              </marker>
            </defs>
            {view.edges.map((e) => {
              const from = byId.get(e.from_frame)
              const to = byId.get(e.to_frame)
              if (!from || !to) return null
              const end = borderPoint(from, to)
              return (
                <line
                  key={`edge-line-${e.id}`}
                  className="edge-line"
                  x1={cx(from)}
                  y1={cy(from)}
                  x2={end.x}
                  y2={end.y}
                  markerEnd="url(#arrow)"
                />
              )
            })}
          </svg>

          {view.edges.map((e) => {
            const from = byId.get(e.from_frame)
            const to = byId.get(e.to_frame)
            if (!from || !to) return null
            const end = borderPoint(from, to)
            const mx = (cx(from) + end.x) / 2
            const my = (cy(from) + end.y) / 2
            return (
              <div
                key={`edge-${e.id}`}
                className="edge-label"
                style={{ left: mx, top: my }}
              >
                {e.label && <span>{e.label}</span>}
                <button
                  className="edge-del"
                  title="delete edge"
                  onClick={() => removeEdge(e.id)}
                >
                  ✕
                </button>
              </div>
            )
          })}

          {placed.map((f) => (
            <div
              key={`frame-${f.id}`}
              className={
                'frame' +
                (selectedId === f.id ? ' selected' : '') +
                (connectFrom === f.id ? ' connect-from' : '')
              }
              style={{
                left: f.x,
                top: f.y,
                width: f.w,
                height: f.h,
                borderColor: f.color ?? undefined,
              }}
              onClick={() => clickFrame(f)}
            >
              <div
                className="frame-header"
                onPointerDown={(e) => onPointerDown(e, f)}
                onPointerMove={(e) => onPointerMove(e, f)}
                onPointerUp={(e) => onPointerUp(e, f)}
              >
                <span className="frame-title">{f.title}</span>
                <span className="frame-id muted">#{f.id}</span>
              </div>
              {f.body && <div className="frame-body">{f.body}</div>}
              <div className="frame-foot muted">
                {f.task_id !== null && (
                  <span className="badge">task #{f.task_id}</span>
                )}
                {f.author && <span>{f.author}</span>}
              </div>
            </div>
          ))}
        </div>
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
