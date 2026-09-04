import { useState } from 'react'
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

  return (
    <aside
      className={`live-board${open ? '' : ' collapsed'}`}
      aria-label="the live whiteboard"
    >
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
