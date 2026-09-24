import { boardTitle, boardViewFor, type BoardView } from './liveBoard'
import type { LiveBoardKind } from './types/LiveBoardKind'
import type { LiveBoardSummary } from './types/LiveBoardSummary'

/**
 * The whiteboard's pen (mesa task 1353) — the bookkeeping behind drawing on a
 * board, kept here beside a test while `LiveBoardPanel.tsx` owns the canvas
 * and the pointer (jsdom has no canvas).
 *
 * Ink is **the person's, and local** until they speak: strokes are held per
 * board id in this browser, and the agent sees them only as a PNG riding on
 * the next user turn this page sends. So the questions that have historically
 * shipped wrong are all here — whether there is ink the agent has not seen
 * yet, whether the layout is frozen for it, which turn of a flush carries it,
 * and whether a newly pushed board may take the panel away from it.
 */

/** One sampled pointer position, in the content box's **content**
 *  coordinates (CSS px, scroll included), so a stroke stays on what it was
 *  drawn over when the content scrolls. */
export interface InkPoint {
  x: number
  y: number
}

/** One pen-down-to-pen-up line. Never mutated once drawn: undo and send both
 *  compare strokes by identity. */
export type InkStroke = readonly InkPoint[]

/**
 * The content box as it was when the first unsent stroke was drawn — the
 * frozen layout. Its size is pinned inline and its scroll locked while there
 * is unsent ink, so the strokes and the content under them cannot drift
 * apart, and it is also the size the flattened PNG is drawn at.
 */
export interface InkFrame {
  width: number
  height: number
  scrollLeft: number
  scrollTop: number
}

/** One board's ink. */
export interface BoardInk {
  /** What is drawn, oldest first. */
  strokes: readonly InkStroke[]
  /** What the agent has seen — the strokes the last successfully sent turn
   *  carried. Ink is *new* exactly when this is not what is drawn. */
  seen: readonly InkStroke[]
  /** The frozen layout — present exactly while there is new ink. */
  frame: InkFrame | null
}

/** Every board's ink, by board id — ink stays with the board it was drawn on
 *  and never carries over to another. */
export type InkBook = Readonly<Record<number, BoardInk>>

/** A page that has drawn nothing. */
export function emptyInkBook(): InkBook {
  return {}
}

const BLANK: BoardInk = { strokes: [], seen: [], frame: null }

/** One board's ink, or none. */
export function boardInk(book: InkBook, boardId: number): BoardInk {
  return book[boardId] ?? BLANK
}

function sameStrokes(a: readonly InkStroke[], b: readonly InkStroke[]): boolean {
  return a.length === b.length && a.every((stroke, i) => stroke === b[i])
}

/**
 * Whether a board carries ink the agent has not seen — the dirty flag.
 *
 * Set by any stroke and by any undo that changes what the agent last saw;
 * cleared by a send that carried it, and by clearing. Undoing every unsent
 * stroke is back to what was sent, so it is clean again rather than a turn
 * carrying a picture of nothing new.
 */
export function inkIsNew(ink: BoardInk): boolean {
  return !sameStrokes(ink.strokes, ink.seen)
}

function withBoard(book: InkBook, boardId: number, ink: BoardInk): InkBook {
  return { ...book, [boardId]: ink }
}

/**
 * A stroke drawn. The **first** new stroke freezes the layout at `frame`, the
 * content box as it stood when the pen went down; later ones keep that frame,
 * since the whole point of a frozen layout is that it does not move under
 * the ink. A stroke with no points is a tap that drew nothing.
 */
export function addStroke(
  book: InkBook,
  boardId: number,
  stroke: InkStroke,
  frame: InkFrame,
): InkBook {
  if (stroke.length === 0) return book
  const ink = boardInk(book, boardId)
  return withBoard(book, boardId, {
    strokes: [...ink.strokes, stroke],
    seen: ink.seen,
    frame: inkIsNew(ink) && ink.frame !== null ? ink.frame : frame,
  })
}

/**
 * The newest stroke taken back. Unfreezes when that leaves nothing new; and
 * taking back a stroke the agent has already seen is itself new — the next
 * turn shows it gone — so that freezes at `frame`, the content box as it
 * stands, exactly as a stroke would.
 */
export function undoStroke(book: InkBook, boardId: number, frame: InkFrame): InkBook {
  const ink = boardInk(book, boardId)
  if (ink.strokes.length === 0) return book
  const strokes = ink.strokes.slice(0, -1)
  const next: BoardInk = { strokes, seen: ink.seen, frame: ink.frame ?? frame }
  return withBoard(book, boardId, inkIsNew(next) ? next : { ...next, frame: null })
}

/** Every stroke on a board wiped, sent or not — and the layout unfrozen, with
 *  nothing new to send. */
export function clearInk(book: InkBook, boardId: number): InkBook {
  if (!(boardId in book)) return book
  return withBoard(book, boardId, BLANK)
}

/**
 * A turn carrying `strokes` was sent. The agent has now seen exactly those,
 * so the board is clean — and unfrozen — unless the person drew more while
 * the turn was on its way, in which case the later strokes are still new and
 * the layout stays where they were drawn.
 */
export function markInkSent(
  book: InkBook,
  boardId: number,
  strokes: readonly InkStroke[],
): InkBook {
  const ink = boardInk(book, boardId)
  // Cleared while the turn was on its way: clearing already unfroze the
  // layout and said there is nothing to send, and a late answer must not
  // freeze it again.
  if (ink.frame === null) return book
  const next: BoardInk = { ...ink, seen: strokes }
  return withBoard(book, boardId, inkIsNew(next) ? next : { ...next, frame: null })
}

/** The unsent ink the next turn should carry: which board, and exactly which
 *  strokes (so a send marks those, not whatever is drawn by the time it
 *  lands). `null` when nothing is new. */
export function pendingInk(
  book: InkBook,
): { boardId: number; strokes: readonly InkStroke[]; frame: InkFrame | null } | null {
  for (const [id, ink] of Object.entries(book)) {
    if (inkIsNew(ink)) return { boardId: Number(id), strokes: ink.strokes, frame: ink.frame }
  }
  return null
}

/**
 * The board the layout is frozen for, or `null`. While there is new ink the
 * panel may not resize, maximise, restore, step to another board or close,
 * and its content may not scroll: the strokes are pinned to pixels, and any
 * of those would move the content out from under them.
 */
export function frozenBoard(book: InkBook): number | null {
  return pendingInk(book)?.boardId ?? null
}

/** Drops the ink of boards no longer in the conversation's history — pruned,
 *  or the conversation ended. The same book, by identity, when nothing went. */
export function pruneInk(book: InkBook, boards: readonly LiveBoardSummary[]): InkBook {
  const live = new Set(boards.map((board) => board.id))
  const ids = Object.keys(book).map(Number)
  if (ids.every((id) => live.has(id))) return book
  const next: Record<number, BoardInk> = {}
  for (const id of ids) if (live.has(id)) next[id] = book[id]
  return next
}

/**
 * `boardViewFor`, held while a board is frozen for ink: a newly pushed board
 * does not take the panel away from the one the person is drawing on. The
 * view stays on that board — by id, since a push can prune the oldest board
 * and shift every index — and `seen` is left alone, so the moment the ink is
 * sent or cleared the ordinary rule jumps to whatever arrived meanwhile.
 */
export function heldBoardView(
  view: BoardView,
  boards: readonly LiveBoardSummary[],
  heldId: number | null,
): BoardView {
  if (heldId !== null) {
    const index = boards.findIndex((board) => board.id === heldId)
    if (index >= 0) return index === view.index ? view : { index, seen: view.seen }
  }
  return boardViewFor(view, boards)
}

/**
 * Which turn of one send carries the ink: the **last** of `count`, so a
 * recording the page had to split still hands the agent the picture with the
 * whole of what was said about it. `null` when nothing is sent.
 */
export function inkCarrier(count: number): number | null {
  return count > 0 ? count - 1 : null
}

/**
 * How a board's own pixels reach the flattened PNG under the ink.
 *
 * - `image`: an `<img>` of the board's bytes, drawn where it sits.
 * - `svg`: a diagram, whose SVG is fetched from the render route and drawn
 *   where its `<img>` sits.
 * - `dom`: markdown, rendered in Naru's own DOM, serialized into an SVG
 *   `<foreignObject>` with its computed styles inlined.
 * - `caption`: HTML, an opaque sandboxed frame no page can read back — a
 *   white sheet with a caption naming the board. An unknown kind lands here
 *   too, the one background that reads nothing.
 */
export type InkBackground = 'image' | 'svg' | 'dom' | 'caption'

export function inkBackground(kind: LiveBoardKind): InkBackground {
  if (kind === 'image') return 'image'
  if (kind === 'diagram') return 'svg'
  if (kind === 'markdown') return 'dom'
  return 'caption'
}

/** The caption strip's words: the board's title and its kind. */
export function inkCaption(board: LiveBoardSummary): string {
  return `${boardTitle(board)} · ${board.kind}`
}

/** A point in content coordinates, where it lands in the frozen frame. */
export function framePoint(point: InkPoint, frame: InkFrame): InkPoint {
  return { x: point.x - frame.scrollLeft, y: point.y - frame.scrollTop }
}

/** The pen's colour: a saturated magenta that reads on the dark diagram, on
 *  white and on a screenshot alike. */
export const INK_COLOR = '#ff2bd6'

/** The pen's width, CSS px. */
export const INK_WIDTH = 3

/**
 * The server's `LIVE_INK_MAX` (8 MiB decoded), mirrored: a flatten whose PNG
 * would be refused is redrawn at 1× rather than posted and refused.
 */
export const INK_MAX_BYTES = 8 * 1024 * 1024

/** The decoded size of a base64 payload, without decoding it. */
export function base64Bytes(base64: string): number {
  const pad = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - pad
}
