import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import { liveBoardRenderUrl } from '../api'
import {
  boardAt,
  boardRender,
  boardTitle,
  clampBoardIndex,
  emptyBoardView,
  stepBoard,
  type BoardView,
} from '../liveBoard'
import {
  INK_COLOR,
  INK_MAX_BYTES,
  INK_WIDTH,
  addStroke,
  base64Bytes,
  boardInk,
  clearInk,
  framePoint,
  frozenBoard,
  heldBoardView,
  inkBackground,
  inkCaption,
  undoStroke,
  type InkBook,
  type InkFrame,
  type InkPoint,
  type InkStroke,
} from '../liveInk'
import {
  clampLiveBoardWidth,
  clearLiveBoardWidth,
  loadLiveBoardWidth,
  saveLiveBoardWidth,
} from '../liveBoardWidth'
import type { LiveBoardSummary } from '../types/LiveBoardSummary'
import { useFetch } from '../useFetch'
import { Markdown } from './Markdown'

/**
 * The live conversation's whiteboard (mesa task 1071) — a right-hand sidebar
 * beside the conversation itself, showing the one board the agent pushed
 * last, with the history behind it a step away.
 *
 * The panel is a **reader**. There is no board write route at all: boards are
 * pushed by the CLI, which is the agent running as the person, and the close
 * button here closes exactly like the conversation panel's — a picture put
 * away is not a write. The one request it makes is the render route, and only
 * for the board being looked at: `LiveState.boards` is bodiless, so the poll
 * carries the history as pointers and a megabyte-scale body is fetched once.
 *
 * It also holds a **pen** (mesa task 1353): with the pen on, a drag draws on a
 * canvas laid over the board. The ink is this browser's own, held by the hub
 * per board id (`liveInk.ts`), and reaches the agent only as a PNG on the
 * next turn the person sends — which the hub asks this panel to flatten
 * through `flattenRef`, since only the panel can see the board's pixels. The
 * first unsent stroke freezes the layout — no resize, maximise, restore,
 * stepping, closing or scrolling — until that turn is sent or the ink cleared.
 */

/**
 * The rendered board itself, and the branch that carries the security
 * argument — `ArtifactPreview` in `pages/ArtifactsView.tsx`, deliberately
 * mirrored, because it is the same problem: agent-written markup shown to a
 * person.
 *
 * `html` needs no fetch here at all; the `<iframe>` loads the render route
 * by URL and the route streams the body server-side. Its
 * `sandbox="allow-scripts"` is a SECOND, INDEPENDENT layer over the render
 * route's own CSP header (`RENDER_CSP` in `src/api.rs`, the byte-identical
 * policy the artifact route serves): the header protects a direct navigation
 * to the URL, the attribute protects this framed case even if the header ever
 * regressed. Never add `allow-same-origin` — that hands the framed document
 * mesa's own origin, and with it mesa's storage and every mesa route, the
 * terminal and agents ones included. Never `srcDoc`, never
 * `dangerouslySetInnerHTML`: the whole point is that the body is parsed by
 * the browser as a document at an opaque origin, never injected into mesa's
 * own DOM.
 *
 * `image` and `diagram` are an `<img>`, so the bytes are never treated as
 * markup (and the pen's flatten draws the diagram back exactly where it
 * sits), and `markdown` is the one kind whose body the page fetches itself, since
 * `<Markdown>` renders text rather than loading a URL — and the one kind that
 * is safe in mesa's own DOM, because that component passes no raw HTML
 * through.
 */
function BoardBody({ board }: { board: LiveBoardSummary }) {
  const url = liveBoardRenderUrl(board.id)
  const render = boardRender(board.kind)
  if (render === 'markdown') return <BoardMarkdown id={board.id} />
  if (render === 'image') {
    return <img className="live-board-image" src={url} alt={boardTitle(board)} />
  }
  return (
    <iframe
      className="live-board-frame"
      title={boardTitle(board)}
      src={url}
      sandbox="allow-scripts"
    />
  )
}

/**
 * The markdown branch's own fetch, keyed by board id — `useFetch`'s ordinary
 * shape, and the same split `ArtifactMarkdownPreview` makes: the list is one
 * request, the body being looked at is another. The render route answers
 * `text/markdown` rather than JSON, so it is read with `fetch` directly
 * instead of through `api.ts`'s `request()` — the URL itself still comes from
 * there (`liveBoardRenderUrl`), like every other URL this app builds.
 */
function BoardMarkdown({ id }: { id: number }) {
  const { data, error } = useFetch(
    () =>
      fetch(liveBoardRenderUrl(id)).then((res) => {
        if (!res.ok) throw new Error(`board ${id} could not be read`)
        return res.text()
      }),
    `live-board-${id}`,
  )
  if (error) return <p className="error">{error}</p>
  if (data === null) return <p className="muted">Loading…</p>
  return (
    <div className="live-board-markdown">
      <Markdown text={data} />
    </div>
  )
}

/** The close button's glyph — `LiveHub`'s own `CloseMark`, in the shape every
 *  `.live-icon` wears. */
function CloseMark() {
  return (
    <svg
      className="live-icon-mark"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

/** Maximise/restore, drawn as four corner brackets pointing out or in —
 *  `AgentSidebar`'s own `MaximizeGlyph`, redrawn on the 24-unit grid every
 *  `.live-icon-mark` uses (as `CloseMark` above is `LiveHub`'s close glyph
 *  redrawn), rather than a glyph-font character whose weight and baseline
 *  differ per platform. */
function MaximizeMark({ restore }: { restore: boolean }) {
  return (
    <svg
      className="live-icon-mark"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      {restore ? (
        <>
          <path d="M4 9h5V4" />
          <path d="M20 9h-5V4" />
          <path d="M20 15h-5v5" />
          <path d="M4 15h5v5" />
        </>
      ) : (
        <>
          <path d="M4 9V4h5" />
          <path d="M15 4h5v5" />
          <path d="M20 15v5h-5" />
          <path d="M9 20H4v-5" />
        </>
      )}
    </svg>
  )
}

/** The pen, undo and clear glyphs, on the same 24-unit grid. */
function PenMark() {
  return (
    <svg
      className="live-icon-mark"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 20l1-5L16 4l4 4L9 19z" />
      <path d="M14 6l4 4" />
    </svg>
  )
}

function UndoMark() {
  return (
    <svg
      className="live-icon-mark"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10a6 6 0 010 12h-3" />
    </svg>
  )
}

function ClearMark() {
  return (
    <svg
      className="live-icon-mark"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 7h16" />
      <path d="M9 7V4h6v3" />
      <path d="M6 7l1 13h10l1-13" />
    </svg>
  )
}

/** Flattens one board with its ink into a base64 PNG — `LiveHub` calls this
 *  when a turn is about to carry the ink. */
export type InkFlatten = (
  boardId: number,
  strokes: readonly InkStroke[],
  frame: InkFrame,
) => Promise<string>

/** One stroke onto a 2D context, points already in the context's space. A
 *  one-point stroke — a tap — is a dot. */
function strokeOnto(ctx: CanvasRenderingContext2D, points: readonly InkPoint[]) {
  if (points.length === 0) return
  ctx.strokeStyle = INK_COLOR
  ctx.fillStyle = INK_COLOR
  ctx.lineWidth = INK_WIDTH
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (points.length === 1) {
    ctx.beginPath()
    ctx.arc(points[0].x, points[0].y, INK_WIDTH / 2, 0, Math.PI * 2)
    ctx.fill()
    return
  }
  ctx.beginPath()
  ctx.moveTo(points[0].x, points[0].y)
  for (const p of points.slice(1)) ctx.lineTo(p.x, p.y)
  ctx.stroke()
}

/** An `<img>` loaded from `src`, or a rejection. */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('the board image could not be loaded'))
    img.src = src
  })
}

/** Where an element sits inside the content box, in the frame's space — the
 *  same visible window the canvas overlay covers. */
function rectIn(el: Element, content: HTMLElement) {
  const r = el.getBoundingClientRect()
  const c = content.getBoundingClientRect()
  return { x: r.left - c.left, y: r.top - c.top, width: r.width, height: r.height }
}

/** A deep clone of `src` with every element's computed style written inline,
 *  so it renders the same inside an SVG `<foreignObject>`, where Naru's
 *  stylesheet does not reach. */
function cloneWithStyles(src: HTMLElement): HTMLElement {
  const clone = src.cloneNode(true) as HTMLElement
  const inline = (from: Element, to: Element) => {
    const cs = getComputedStyle(from)
    let css = ''
    for (let i = 0; i < cs.length; i++) {
      const prop = cs[i]
      css += `${prop}:${cs.getPropertyValue(prop)};`
    }
    to.setAttribute('style', css)
    for (let i = 0; i < from.children.length; i++) {
      const child = to.children[i]
      if (child !== undefined) inline(from.children[i], child)
    }
  }
  inline(src, clone)
  return clone
}

/**
 * The board's own pixels under the ink, per kind (`liveInk.ts::inkBackground`),
 * drawn at the frame's size into a context already scaled to CSS px. Throws
 * on anything it cannot draw; the caller then draws the caption instead.
 */
async function drawBoardBackground(
  ctx: CanvasRenderingContext2D,
  board: LiveBoardSummary,
  content: HTMLElement,
  frame: InkFrame,
) {
  const background = inkBackground(board.kind)
  if (background === 'caption') throw new Error('an html board cannot be read back')
  // The panel's own backdrop first, so whatever the board does not cover
  // looks as it did on screen.
  ctx.fillStyle = getComputedStyle(content.closest('.live-board') ?? content).backgroundColor
  ctx.fillRect(0, 0, frame.width, frame.height)
  if (background === 'image') {
    const img = content.querySelector('img')
    if (img === null) throw new Error('no image on the board')
    await img.decode()
    const at = rectIn(img, content)
    ctx.drawImage(img, at.x, at.y, at.width, at.height)
    return
  }
  if (background === 'svg') {
    const img = content.querySelector('img')
    if (img === null) throw new Error('no diagram on the board')
    const res = await fetch(liveBoardRenderUrl(board.id))
    if (!res.ok) throw new Error(`board ${board.id} could not be read`)
    const url = URL.createObjectURL(
      new Blob([await res.text()], { type: 'image/svg+xml' }),
    )
    try {
      const svg = await loadImage(url)
      const at = rectIn(img, content)
      ctx.drawImage(svg, at.x, at.y, at.width, at.height)
    } finally {
      URL.revokeObjectURL(url)
    }
    return
  }
  // Markdown: the content box itself, cloned with its styles inlined, shifted
  // by the frozen scroll and cut to the frame — what was visible, and only
  // that.
  const clone = cloneWithStyles(content)
  clone.style.width = `${frame.width}px`
  clone.style.height = 'auto'
  clone.style.overflow = 'visible'
  clone.style.margin = `${-frame.scrollTop}px 0 0 ${-frame.scrollLeft}px`
  const box = document.createElement('div')
  box.style.width = `${frame.width}px`
  box.style.height = `${frame.height}px`
  box.style.overflow = 'hidden'
  box.appendChild(clone)
  const xhtml = new XMLSerializer().serializeToString(box)
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${frame.width}" height="${frame.height}">` +
    `<foreignObject x="0" y="0" width="100%" height="100%">${xhtml}</foreignObject></svg>`
  const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
  ctx.drawImage(img, 0, 0, frame.width, frame.height)
}

/** The background no board can fail to have: white, with a strip naming the
 *  board. What an HTML board always gets, and any other kind whose own pixels
 *  could not be drawn or read back. */
function drawCaptionBackground(
  ctx: CanvasRenderingContext2D,
  board: LiveBoardSummary | null,
  frame: InkFrame,
) {
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, frame.width, frame.height)
  ctx.fillStyle = '#eef1f5'
  ctx.fillRect(0, 0, frame.width, 32)
  ctx.fillStyle = '#1f2933'
  ctx.font = '14px sans-serif'
  ctx.textBaseline = 'middle'
  ctx.fillText(board === null ? 'Whiteboard' : inkCaption(board), 10, 16, frame.width - 20)
}

/**
 * One flatten at one scale: background, then the ink on top. `real` asks for
 * the board's own pixels; when those fail to draw — or taint the canvas, which
 * is Safari's answer to a `<foreignObject>` — the answer is `null` and the
 * caller retries with the caption, so the ink itself is never dropped.
 */
async function flattenAt(
  scale: number,
  real: boolean,
  board: LiveBoardSummary | null,
  content: HTMLElement | null,
  strokes: readonly InkStroke[],
  frame: InkFrame,
): Promise<string | null> {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(frame.width * scale))
  canvas.height = Math.max(1, Math.round(frame.height * scale))
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('this browser cannot draw the ink')
  ctx.scale(scale, scale)
  if (real && board !== null && content !== null) {
    try {
      await drawBoardBackground(ctx, board, content, frame)
    } catch {
      return null
    }
  } else {
    drawCaptionBackground(ctx, board, frame)
  }
  for (const stroke of strokes) strokeOnto(ctx, stroke.map((p) => framePoint(p, frame)))
  try {
    return canvas.toDataURL('image/png').split(',')[1] ?? null
  } catch {
    return null
  }
}

export function LiveBoardPanel({
  boards,
  open,
  onClose,
  ink,
  onInk,
  flattenRef,
}: {
  /** The conversation's whole board history, oldest first and bodiless — the
   *  `boards` array of the poll `LiveHub` already makes, never a second one. */
  boards: LiveBoardSummary[]
  open: boolean
  /** Closes the panel and nothing else: there is no route behind this. */
  onClose: () => void
  /** Every board's ink, held by the hub so a turn it sends can carry it. */
  ink: InkBook
  /** The one write path for `ink`. */
  onInk: (update: (book: InkBook) => InkBook) => void
  /** Set by this panel to its flatten, for the hub to call on send. */
  flattenRef: RefObject<InkFlatten | null>
}) {
  // The board the layout is frozen for, while it carries unsent ink (mesa
  // task 1353): a new push does not take the panel away from it
  // (`heldBoardView`), and every control that would move its content is off.
  const held = frozenBoard(ink)
  const frozen = held !== null
  // Which board is showing, and how much of the history this panel has
  // accounted for. State rather than a prop: stepping back is this browser's
  // own business, exactly as pausing and closing are, and the hub has no say
  // in it. `boardViewFor` is what re-applies the rule that a push replaces
  // what is showing on every poll.
  // Seeded from the boards on hand rather than empty: a page that reloads
  // mid-conversation mounts this with a history already in it, and a view that
  // waited for the next poll to notice would show the head's `N/M` as `0`.
  const [view, setView] = useState<BoardView>(() =>
    heldBoardView(emptyBoardView(), boards, held),
  )
  // Re-applied during render off the changed prop rather than in an effect —
  // `useFetch.ts`'s own pattern, and for its reason: an effect would render
  // the previous board once before correcting itself, and the repo lints
  // against that cascade. `heldBoardView` answers with the view it was given
  // when nothing moved, so this settles in one pass. The freeze lifting is a
  // change too: it is when a board pushed meanwhile is finally shown.
  const [prevBoards, setPrevBoards] = useState(boards)
  const [prevHeld, setPrevHeld] = useState(held)
  if (boards !== prevBoards || held !== prevHeld) {
    setPrevBoards(boards)
    setPrevHeld(held)
    setView(heldBoardView(view, boards, held))
  }

  // The index the panel is actually on: `null` means the newest, so the head's
  // counter has to read the clamped answer rather than the held one.
  const index = clampBoardIndex(view.index, boards.length)
  const showing = boardAt(boards, index)
  const at = index === null ? 0 : index + 1
  const first = at <= 1
  const last = at >= boards.length

  function step(delta: number) {
    setView((held) => ({ ...held, index: stepBoard(held.index, delta, boards.length) }))
  }

  // How wide the picture is, and this browser's own business exactly as which
  // board is showing is. `null` is "no opinion", and the panel then sets no
  // inline custom property at all so App.css's `min(40rem, 50vw)` stands —
  // see `liveBoardWidth.ts` for why the default cannot be a number.
  const [width, setWidth] = useState<number | null>(() => loadLiveBoardWidth())
  const [resizing, setResizing] = useState(false)
  // Maximised: the board covers the whole main area — the page behind it, and
  // nothing else. It is `width: 100%` of `.main-slot`, which is what the panel
  // is positioned inside, so the conversation sidebar and the left nav are out
  // of reach by construction rather than by arithmetic.
  const [maximized, setMaximized] = useState(false)
  const asideRef = useRef<HTMLElement | null>(null)
  // The width the drag has reached, so `mouseup` can store it without the
  // effect having to re-subscribe on every frame of the drag.
  const widthRef = useRef(width)

  // Drag-resize: the handle is on the panel's left edge and the panel is
  // pinned to `.main-slot`'s right edge, so the new width is the distance from
  // the pointer to that edge — measured off the offset parent rather than the
  // viewport, since the slot is what the panel is 100% of. Listeners live on
  // `document`, not the handle, so the drag keeps tracking when the pointer
  // outruns it (`AgentSidebar`'s own splitter, and its reason).
  useEffect(() => {
    if (!resizing) return
    const onMove = (e: MouseEvent) => {
      const slot = asideRef.current?.offsetParent
      if (!(slot instanceof HTMLElement)) return
      const box = slot.getBoundingClientRect()
      const next = clampLiveBoardWidth(box.right - e.clientX, box.width)
      widthRef.current = next
      setWidth(next)
    }
    const onUp = () => {
      setResizing(false)
      // Stored on release rather than per frame: a drag is one decision, and
      // localStorage is synchronous.
      if (widthRef.current !== null) saveLiveBoardWidth(widthRef.current)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.classList.add('live-board-resizing')
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.classList.remove('live-board-resizing')
    }
  }, [resizing])

  // Escape is the way out of whatever the panel is currently doing: it
  // restores a maximised board first, and only closes the panel once the board
  // is back at its own width — one press should never both un-maximise and
  // dismiss. Bound only while open, so it never swallows an Escape the rest of
  // the app wants while there is no board on screen.
  // Frozen for ink, it does neither: both would move the content out from
  // under the strokes.
  useEffect(() => {
    if (!open || frozen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (maximized) setMaximized(false)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, frozen, maximized, onClose])

  // ---- the pen (mesa task 1353) ----

  // Opt-in, so a board with the pen off scrolls and its frame takes clicks
  // exactly as before; this browser's own switch, like pausing.
  const [pen, setPen] = useState(false)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // The stroke being drawn, before the pen lifts and it joins the book — and
  // the frame the content box stood in when it went down.
  const drawing = useRef<{ points: InkPoint[]; frame: InkFrame } | null>(null)
  // The content box's size, which the overlay canvas is kept exactly over.
  const [box, setBox] = useState<{ width: number; height: number }>({ width: 0, height: 0 })
  const showingInk = showing === null ? null : boardInk(ink, showing.id)
  const frame = showing !== null && held === showing.id ? (showingInk?.frame ?? null) : null
  // Whether the content box had a vertical scrollbar when it froze: the
  // frozen box hides its overflow, and reserving the gutter the scrollbar
  // took is what keeps its text from reflowing into the freed width.
  const [gutter, setGutter] = useState(false)

  const currentFrame = useCallback((): InkFrame | null => {
    const content = contentRef.current
    if (content === null) return null
    const rect = content.getBoundingClientRect()
    setGutter(content.offsetWidth - content.clientWidth > 0)
    return {
      width: rect.width,
      height: rect.height,
      scrollLeft: content.scrollLeft,
      scrollTop: content.scrollTop,
    }
  }, [])

  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    const content = contentRef.current
    if (canvas === null || content === null) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    // Content coordinates onto the visible window: the canvas does not
    // scroll, the content under it does.
    const scroll: InkFrame = {
      width: 0,
      height: 0,
      scrollLeft: content.scrollLeft,
      scrollTop: content.scrollTop,
    }
    const strokes = showingInk?.strokes ?? []
    for (const stroke of strokes) strokeOnto(ctx, stroke.map((p) => framePoint(p, scroll)))
    if (drawing.current !== null) {
      strokeOnto(ctx, drawing.current.points.map((p) => framePoint(p, scroll)))
    }
  }, [showingInk])

  // The canvas follows the content box's size; a resize clears a canvas, so
  // every size change redraws.
  useLayoutEffect(() => {
    const content = contentRef.current
    if (content === null) return
    const measure = () => {
      const rect = content.getBoundingClientRect()
      setBox((prev) =>
        prev.width === rect.width && prev.height === rect.height
          ? prev
          : { width: rect.width, height: rect.height },
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(content)
    return () => observer.disconnect()
  }, [])

  // Pinned to where the ink was drawn, whatever reflowed around it.
  useLayoutEffect(() => {
    const content = contentRef.current
    if (content === null || frame === null) return
    content.scrollLeft = frame.scrollLeft
    content.scrollTop = frame.scrollTop
  }, [frame])

  useLayoutEffect(() => {
    redraw()
  }, [redraw, box])

  function pointAt(e: ReactPointerEvent<HTMLCanvasElement>): InkPoint | null {
    const content = contentRef.current
    if (content === null) return null
    const rect = e.currentTarget.getBoundingClientRect()
    return {
      x: e.clientX - rect.left + content.scrollLeft,
      y: e.clientY - rect.top + content.scrollTop,
    }
  }

  function penDown(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (!pen || showing === null) return
    const point = pointAt(e)
    const at = currentFrame()
    if (point === null || at === null) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drawing.current = { points: [point], frame: at }
    redraw()
  }

  function penMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (drawing.current === null) return
    const point = pointAt(e)
    if (point === null) return
    drawing.current.points.push(point)
    redraw()
  }

  function penUp() {
    const stroke = drawing.current
    drawing.current = null
    if (stroke === null || showing === null) return
    const id = showing.id
    onInk((book) => addStroke(book, id, stroke.points, stroke.frame))
  }

  function undo() {
    if (showing === null) return
    const at = currentFrame()
    if (at === null) return
    const id = showing.id
    onInk((book) => undoStroke(book, id, at))
  }

  function clear() {
    if (showing === null) return
    const id = showing.id
    onInk((book) => clearInk(book, id))
  }

  // The hub's way to the pixels: only this panel can see the board, so the
  // flatten lives here and is handed up through a ref, refreshed every render
  // so it always reads the board that is showing now.
  useEffect(() => {
    flattenRef.current = async (boardId, strokes, at) => {
      const board = boards.find((b) => b.id === boardId) ?? null
      // Only the board on screen has pixels to read; any other falls to the
      // caption, and still carries its ink.
      const content = showing?.id === boardId ? contentRef.current : null
      const dpr = window.devicePixelRatio || 1
      let png: string | null = null
      for (const scale of dpr > 1 ? [dpr, 1] : [1]) {
        png =
          (await flattenAt(scale, true, board, content, strokes, at)) ??
          (await flattenAt(scale, false, board, content, strokes, at))
        // Past the server's cap it would be refused; redrawn at 1× instead.
        if (png !== null && base64Bytes(png) <= INK_MAX_BYTES) return png
      }
      if (png === null) throw new Error('the ink could not be drawn')
      return png
    }
  })

  return (
    <aside
      ref={asideRef}
      className={`live-board${open ? '' : ' collapsed'}${maximized ? ' maximized' : ''}${
        resizing ? ' resizing' : ''
      }`}
      // Nothing stored and nothing dragged means no inline property at all —
      // the stylesheet's `min(40rem, 50vw)` is the default, not a number.
      style={
        width === null
          ? undefined
          : ({ '--live-board-width': `${width}px` } as CSSProperties)
      }
      aria-label="the live whiteboard"
    >
      {/* Not rendered while maximised (there is no width to drag) nor while
          clipped away, where the pointer cannot reach it anyway. */}
      {open && !maximized && !frozen && (
        <div
          className="live-board-resize-handle"
          onMouseDown={(e) => {
            e.preventDefault()
            setResizing(true)
          }}
          onDoubleClick={() => {
            widthRef.current = null
            clearLiveBoardWidth()
            setWidth(null)
          }}
        />
      )}
      <div className="live-board-body">
        <div className="live-sidebar-head live-board-head">
          <div className="live-head-row">
            <div className="live-head-say">
              <div className="live-head-title">
                {showing === null ? 'Whiteboard' : boardTitle(showing)}
              </div>
              {showing !== null && (
                <span className="live-chip live-board-kind">{showing.kind}</span>
              )}
            </div>
            <div className="live-head-actions">
              {/* The history, and the only control here that is not the close
                  button. Shown once there is more than one board: a single
                  board has nothing to step through, and `‹ 1/1 ›` reads as
                  two buttons that are broken. */}
              {boards.length > 1 && (
                <div className="live-board-steps">
                  <button
                    type="button"
                    className="live-board-step"
                    aria-label="the previous board"
                    tabIndex={open ? undefined : -1}
                    disabled={first || frozen}
                    onClick={() => step(-1)}
                  >
                    ‹
                  </button>
                  <span className="live-board-count">
                    {at}/{boards.length}
                  </span>
                  <button
                    type="button"
                    className="live-board-step"
                    aria-label="the next board"
                    tabIndex={open ? undefined : -1}
                    disabled={last || frozen}
                    onClick={() => step(1)}
                  >
                    ›
                  </button>
                </div>
              )}
              {/* The pen, and while it is on, its undo and clear. */}
              {showing !== null && (
                <button
                  type="button"
                  className="live-icon live-board-pen"
                  aria-label={pen ? 'put the pen down' : 'draw on the whiteboard'}
                  aria-pressed={pen}
                  title={pen ? 'Stop drawing' : 'Draw on the board'}
                  tabIndex={open ? undefined : -1}
                  onClick={() => setPen((on) => !on)}
                >
                  <PenMark />
                </button>
              )}
              {pen && showing !== null && (
                <>
                  <button
                    type="button"
                    className="live-icon live-board-undo"
                    aria-label="undo the last stroke"
                    title="Undo"
                    tabIndex={open ? undefined : -1}
                    disabled={(showingInk?.strokes.length ?? 0) === 0}
                    onClick={undo}
                  >
                    <UndoMark />
                  </button>
                  <button
                    type="button"
                    className="live-icon live-board-clear"
                    aria-label="clear the ink"
                    title="Clear the ink"
                    tabIndex={open ? undefined : -1}
                    disabled={(showingInk?.strokes.length ?? 0) === 0}
                    onClick={clear}
                  >
                    <ClearMark />
                  </button>
                </>
              )}
              <button
                type="button"
                className="live-icon live-board-maximize"
                aria-label={
                  maximized
                    ? 'restore the whiteboard width'
                    : 'fill the page with the whiteboard'
                }
                title={maximized ? 'Restore width (Esc)' : 'Fill the page'}
                tabIndex={open ? undefined : -1}
                disabled={frozen}
                onClick={() => setMaximized((m) => !m)}
              >
                <MaximizeMark restore={maximized} />
              </button>
              <button
                type="button"
                className="live-icon live-board-close"
                aria-label="hide the whiteboard"
                // Out of the tab order while the panel is clipped, for the
                // conversation panel's reason: `pointer-events` stops the
                // mouse, not a Tab, and an invisible button a Tab can land on
                // is a trap.
                tabIndex={open ? undefined : -1}
                disabled={frozen}
                onClick={onClose}
              >
                <CloseMark />
              </button>
            </div>
          </div>
        </div>

        {/* The stage holds the content box and the ink canvas laid exactly
            over it. Frozen, the box is pinned to the px size it had when the
            first unsent stroke went down, and its overflow hidden, so neither
            a window resize nor a scroll can move the content under the ink. */}
        <div className="live-board-stage">
          <div
            ref={contentRef}
            className={`live-board-content${frozen ? ' inked' : ''}`}
            onScroll={redraw}
            style={
              frame === null
                ? undefined
                : {
                    flex: 'none',
                    width: `${frame.width}px`,
                    height: `${frame.height}px`,
                    overflow: 'hidden',
                    scrollbarGutter: gutter ? 'stable' : undefined,
                  }
            }
          >
            {showing === null ? (
              <p className="muted">Nothing on the whiteboard yet.</p>
            ) : (
              // Keyed by board id so a switch to another board mounts a fresh
              // frame/image/fetch rather than re-pointing the one on screen —
              // the previous board's pixels must not sit under the new one's
              // while it loads.
              <BoardBody key={showing.id} board={showing} />
            )}
          </div>
          <canvas
            ref={canvasRef}
            className={`live-board-ink${pen ? ' drawing' : ''}`}
            width={Math.max(1, Math.round(box.width * (window.devicePixelRatio || 1)))}
            height={Math.max(1, Math.round(box.height * (window.devicePixelRatio || 1)))}
            style={{ width: `${box.width}px`, height: `${box.height}px` }}
            onPointerDown={penDown}
            onPointerMove={penMove}
            onPointerUp={penUp}
            onPointerCancel={penUp}
          />
        </div>
      </div>
    </aside>
  )
}
