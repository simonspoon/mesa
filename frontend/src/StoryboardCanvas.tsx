import { useEffect, useRef, useState } from 'react'
import {
  createEdge,
  createFrame,
  deleteEdge,
  deleteFrame,
  updateFrame,
} from './api'
import { loadBoardView, saveBoardView } from './boardView'
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

/** Pan/zoom view transform applied to the content layer as
 *  `translate(tx, ty) scale(scale)` with transform-origin 0 0. This is a pure
 *  view layer over the saved frame x/y (never persisted on the board). Later
 *  stories read/persist this same shape, so it is kept as one structured value. */
type ViewTransform = {
  tx: number
  ty: number
  scale: number
}

const MIN_SCALE = 0.25
const MAX_SCALE = 3
const ZOOM_STEP = 0.0015 // per wheel deltaY unit
const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))

const DEFAULT_TRANSFORM: ViewTransform = { tx: 0, ty: 0, scale: 1 }

/** Pan gesture in progress: where the pointer went down and the transform at
 *  that moment. Pan moves the view by the raw client delta (screen-space). */
type Pan = {
  pointerId: number
  startX: number
  startY: number
  tx: number
  ty: number
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
  // Expanded mode: the canvas takes over the whole window (CSS fixes the root to
  // the viewport). Purely a view-layer toggle, never persisted on the board.
  const [expanded, setExpanded] = useState(false)
  // Live position of the frame currently being dragged; overlays the server
  // position so the drag is smooth without copying the whole frame list.
  const [dragPos, setDragPos] = useState<{ id: number; x: number; y: number } | null>(
    null,
  )
  const dragRef = useRef<Drag | null>(null)
  const justDragged = useRef(false)

  // Pan/zoom view transform (story 01). Browser-local view state (story 03):
  // restored from localStorage on open and persisted on change, keyed by board.
  // Held in React state so it survives the parent's refetch-on-mutation (the
  // component is not remounted across `onChanged`); the lazy init seeds the
  // first board, and the effect below re-seeds when the board id changes
  // (boards switch in place, without a remount).
  const [transform, setTransform] = useState<ViewTransform>(
    () => loadBoardView(storyboardId) ?? DEFAULT_TRANSFORM,
  )
  const [panning, setPanning] = useState(false)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const panRef = useRef<Pan | null>(null)

  // Reseed the view when the board changes without a remount, then persist the
  // current view per board on every change. `transformBoard` records which
  // board the live `transform` value belongs to (advanced only by the persist
  // effect, once `transform` has actually been replaced with the new board's
  // view). On a board switch the reseed loads and applies the new board's saved
  // view; the persist runs only when `transform` and `storyboardId` agree, so
  // the outgoing board's transform is never written under the new board's key.
  const transformBoard = useRef(storyboardId)
  useEffect(() => {
    if (transformBoard.current !== storyboardId) {
      setTransform(loadBoardView(storyboardId) ?? DEFAULT_TRANSFORM)
    }
  }, [storyboardId])
  useEffect(() => {
    if (transformBoard.current !== storyboardId) {
      // First render after a board switch, before the reseed's setTransform has
      // landed: `transform` still belongs to the previous board — don't write
      // it under the new key. The reseed's state update re-runs this effect.
      transformBoard.current = storyboardId
      return
    }
    saveBoardView(storyboardId, transform)
  }, [storyboardId, transform])

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
    // Frames live inside the scaled content layer, so a board-space delta shows
    // on screen as delta * scale. To keep the card under the cursor 1:1, convert
    // the client (screen) delta back to board space by dividing by the current
    // scale. The pan offset (tx/ty) is a constant translation that cancels out
    // in a delta, so it never enters the saved x/y.
    const nx = d.ox + (e.clientX - d.startX) / transform.scale
    const ny = d.oy + (e.clientY - d.startY) / transform.scale
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

  // Wheel zoom centred on the cursor: keep the world point under the pointer
  // fixed on screen while scale changes. world = (screen - t) / scale, so after
  // scaling we solve t' = screen - world * scale'. Bound as a native non-passive
  // listener so preventDefault() actually suppresses page scroll (React's
  // synthetic onWheel is passive and cannot).
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      setTransform((t) => {
        const next = clampScale(t.scale * Math.exp(-e.deltaY * ZOOM_STEP))
        if (next === t.scale) return t
        const wx = (px - t.tx) / t.scale
        const wy = (py - t.ty) / t.scale
        return { scale: next, tx: px - wx * next, ty: py - wy * next }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

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

  // Pan starts only when the pointer goes down on empty canvas (not on a frame)
  // and not in connect-mode; frame drags own their own pointer handlers. Pan
  // translates the view by the raw client delta (screen-space, scale-free).
  function onViewportPointerDown(e: React.PointerEvent) {
    if (e.button !== 0 || connectMode) return
    // Empty canvas only: not on a frame, edge label, or an in-canvas control.
    if (
      (e.target as HTMLElement).closest(
        '.frame, .edge-label, .canvas-controls, .canvas-expand',
      )
    )
      return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    panRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      tx: transform.tx,
      ty: transform.ty,
    }
    setPanning(true)
  }

  function onViewportPointerMove(e: React.PointerEvent) {
    const p = panRef.current
    if (!p || p.pointerId !== e.pointerId) return
    setTransform((t) => ({
      ...t,
      tx: p.tx + (e.clientX - p.startX),
      ty: p.ty + (e.clientY - p.startY),
    }))
  }

  function onViewportPointerUp(e: React.PointerEvent) {
    const p = panRef.current
    if (!p || p.pointerId !== e.pointerId) return
    panRef.current = null
    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    setPanning(false)
  }

  // Reset / fit: bring the cards back into the viewport at a sensible zoom in
  // one action. Computes the bounding box of the placed frames (board space),
  // picks a scale that fits it within the viewport with margin (clamped to the
  // shared [MIN,MAX] range, never zooming past 100%), and centres it. With no
  // frames there is nothing to fit, so fall back to the default origin view.
  // This goes through `setTransform`, so the persist effect (story 03) writes
  // the reset view to localStorage — the reset is what gets remembered.
  const FIT_MARGIN = 48 // board-space padding around the cards' bounding box
  function resetView() {
    const el = viewportRef.current
    if (!el || placed.length === 0) {
      setTransform(DEFAULT_TRANSFORM)
      return
    }
    const minX = Math.min(...placed.map((f) => f.x))
    const minY = Math.min(...placed.map((f) => f.y))
    const maxX = Math.max(...placed.map((f) => f.x + f.w))
    const maxY = Math.max(...placed.map((f) => f.y + f.h))
    const bw = maxX - minX + FIT_MARGIN * 2
    const bh = maxY - minY + FIT_MARGIN * 2
    const rect = el.getBoundingClientRect()
    // Fit the box to the viewport, but never zoom in past 100% — a single small
    // card should not blow up to fill the screen.
    const scale = clampScale(Math.min(rect.width / bw, rect.height / bh, 1))
    // Centre the box: place its scaled centre at the viewport centre.
    const cxBox = minX - FIT_MARGIN + bw / 2
    const cyBox = minY - FIT_MARGIN + bh / 2
    setTransform({
      scale,
      tx: rect.width / 2 - cxBox * scale,
      ty: rect.height / 2 - cyBox * scale,
    })
  }

  return (
    <div
      className={`storyboard${selected ? ' has-panel' : ''}${
        expanded ? ' expanded' : ''
      }`}
    >
      <div
        ref={viewportRef}
        className={`storyboard-viewport${panning ? ' panning' : ''}`}
        onPointerDown={onViewportPointerDown}
        onPointerMove={onViewportPointerMove}
        onPointerUp={onViewportPointerUp}
      >
        {/* Infinite graph-paper grid filling the whole viewport. Lives on a
            fixed full-size layer (behind the content) but its size/position
            track the pan/zoom transform, so the lines stay aligned with the
            frames at every zoom level. */}
        <div
          className="storyboard-grid"
          style={{
            backgroundSize: `${32 * transform.scale}px ${32 * transform.scale}px`,
            backgroundPosition: `${transform.tx}px ${transform.ty}px`,
          }}
        />

        {/* In-canvas controls, pinned top-left over the pan/zoom layer. */}
        <div className="canvas-controls">
          <button onClick={addFrame}>add frame</button>
          <button
            className={connectMode ? 'active' : ''}
            onClick={toggleConnect}
          >
            {connectMode ? 'connecting…' : 'connect'}
          </button>
          <button
            onClick={resetView}
            title="Reset zoom and recentre on the cards"
          >
            reset view
          </button>
          <span className="canvas-hint muted">
            {connectMode
              ? connectFrom === null
                ? 'click a frame to start an edge'
                : 'click the target frame'
              : 'drag a frame to move it · click to edit'}
          </span>
          {error && <span className="error">{error}</span>}
        </div>

        {/* Expand toggle, pinned top-right: take over the whole window. */}
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

        <div
          className="storyboard-content"
          style={{
            transform: `translate(${transform.tx}px, ${transform.ty}px) scale(${transform.scale})`,
            transformOrigin: '0 0',
          }}
        >
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
