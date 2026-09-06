import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { liveBoardRenderUrl } from '../api'
import {
  boardAt,
  boardRender,
  boardTitle,
  boardViewFor,
  clampBoardIndex,
  emptyBoardView,
  stepBoard,
  type BoardView,
} from '../liveBoard'
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
 */

/**
 * The rendered board itself, and the branch that carries the security
 * argument — `ArtifactPreview` in `pages/ArtifactsView.tsx`, deliberately
 * mirrored, because it is the same problem: agent-written markup shown to a
 * person.
 *
 * `html` and `diagram` need no fetch here at all; the `<iframe>` loads the
 * render route by URL and the route streams the body server-side. Its
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
 * `image` is an `<img>`, so the bytes are never treated as markup, and
 * `markdown` is the one kind whose body the page fetches itself, since
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

export function LiveBoardPanel({
  boards,
  open,
  onClose,
}: {
  /** The conversation's whole board history, oldest first and bodiless — the
   *  `boards` array of the poll `LiveHub` already makes, never a second one. */
  boards: LiveBoardSummary[]
  open: boolean
  /** Closes the panel and nothing else: there is no route behind this. */
  onClose: () => void
}) {
  // Which board is showing, and how much of the history this panel has
  // accounted for. State rather than a prop: stepping back is this browser's
  // own business, exactly as pausing and closing are, and the hub has no say
  // in it. `boardViewFor` is what re-applies the rule that a push replaces
  // what is showing on every poll.
  // Seeded from the boards on hand rather than empty: a page that reloads
  // mid-conversation mounts this with a history already in it, and a view that
  // waited for the next poll to notice would show the head's `N/M` as `0`.
  const [view, setView] = useState<BoardView>(() =>
    boardViewFor(emptyBoardView(), boards),
  )
  // Re-applied during render off the changed prop rather than in an effect —
  // `useFetch.ts`'s own pattern, and for its reason: an effect would render
  // the previous board once before correcting itself, and the repo lints
  // against that cascade. `boardViewFor` answers with the view it was given
  // when nothing moved, so this settles in one pass.
  const [prevBoards, setPrevBoards] = useState(boards)
  if (boards !== prevBoards) {
    setPrevBoards(boards)
    setView(boardViewFor(view, boards))
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
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (maximized) setMaximized(false)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, maximized, onClose])

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
      {open && !maximized && (
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
                    disabled={first}
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
                    disabled={last}
                    onClick={() => step(1)}
                  >
                    ›
                  </button>
                </div>
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
                onClick={onClose}
              >
                <CloseMark />
              </button>
            </div>
          </div>
        </div>

        <div className="live-board-content">
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
      </div>
    </aside>
  )
}
