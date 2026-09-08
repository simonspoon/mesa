import type { LiveBoardKind } from './types/LiveBoardKind'
import type { LiveBoardSummary } from './types/LiveBoardSummary'

/**
 * The whiteboard's arithmetic (mesa task 1071) — what the panel is showing,
 * and where its one body is fetched from.
 *
 * A board is a **picture pushed by the agent**, and `GET /api/live` carries
 * the whole history as bodiless summaries: the bodies are megabyte-scale
 * documents, so the poll answers with pointers and exactly one of them is
 * ever fetched, by the render route, for the board being looked at. The two
 * decisions that follow from that — which board is showing, and how its body
 * reaches the screen — are the kind that has historically shipped wrong in a
 * `.tsx`, so they live here beside a test and `LiveBoardPanel.tsx` only
 * performs them (`liveTurns.ts`, same reason). The render route's own URL is
 * not one of them: it is `api.ts::liveBoardRenderUrl`, beside every other URL
 * this app builds.
 *
 * The rule the stepper exists to hold is that **each push replaces what is
 * showing**. A board is a snapshot, not a document with a history: the person
 * may step back through what has already been pushed, but the moment the
 * agent pushes a new one it is what the conversation is talking about, and
 * leaving the panel on an old board would be showing the person a picture
 * nobody is discussing.
 */

/**
 * How a board's body reaches the screen. Three answers for four kinds:
 * `html` and `diagram` are both documents served under the render CSP, and
 * the browser is what parses them — a sandboxed frame, never mesa's own DOM.
 */
export type BoardRender = 'markdown' | 'frame' | 'image'

/**
 * Which of the three a kind takes.
 *
 * `markdown` is the one kind whose body the page has to fetch itself, since
 * `<Markdown>` renders text rather than loading a URL — and it is also the
 * one kind that is *never* framed as a document, which is why it can be
 * rendered in mesa's own DOM at all (`components/Markdown.tsx` passes no raw
 * HTML through). `image` is an `<img>`, so the browser never treats the
 * bytes as markup. Everything else is a frame: an unknown kind arriving from
 * a newer server must land on the *safest* branch, not the most permissive
 * one, so `frame` is the default rather than a special case.
 */
export function boardRender(kind: LiveBoardKind): BoardRender {
  if (kind === 'markdown') return 'markdown'
  if (kind === 'image') return 'image'
  return 'frame'
}

/**
 * What the panel's head calls a board. `title` is free text the agent chose
 * and is routinely absent — a board pushed mid-sentence has nothing to name
 * it — so the fall-back names the row itself rather than leaving the head
 * blank, and a title that is only whitespace counts as absent.
 */
export function boardTitle(board: LiveBoardSummary): string {
  const title = board.title?.trim() ?? ''
  return title === '' ? `Board ${board.id}` : title
}

/**
 * The newest board in a list, by id — the one a push has just made current.
 *
 * The max rather than the last element, for `advanceCursor`'s reason: this
 * value is compared against what the page has already taken in hand, so a
 * list that arrived in an order nobody promised must not be able to move it
 * backwards. `null` for an empty list, which is a conversation that has
 * pushed nothing, or one whose boards were cleared.
 */
export function newestBoardId(boards: readonly LiveBoardSummary[]): number | null {
  let newest: number | null = null
  for (const board of boards) {
    if (newest === null || board.id > newest) newest = board.id
  }
  return newest
}

/**
 * A board index that is certainly in range: `null` when there is nothing to
 * show, and otherwise 0..count-1.
 *
 * Having no index yet means the newest board, not the first: "nothing chosen"
 * and "what is showing" are the same state, and what is showing is always the
 * last thing pushed. The store prunes a session's boards to the newest twenty,
 * so a held index can outlive the row it pointed at — clamping here is what
 * keeps that a shifted picture rather than a blank panel.
 */
export function clampBoardIndex(index: number | null, count: number): number | null {
  if (count <= 0) return null
  if (index === null) return count - 1
  if (index < 0) return 0
  if (index > count - 1) return count - 1
  return index
}

/**
 * The step buttons: back one, forward one, and no further at either end.
 *
 * Deliberately not a wrap-around. The history is short and its ends are
 * meaningful — the newest board is the one being talked about — so stepping
 * past it and landing on the oldest would read as the conversation having
 * jumped backwards.
 */
export function stepBoard(
  index: number | null,
  delta: number,
  count: number,
): number | null {
  const from = clampBoardIndex(index, count)
  if (from === null) return null
  return clampBoardIndex(from + delta, count)
}

/** The board an index names, or `null` when there is none. */
export function boardAt(
  boards: readonly LiveBoardSummary[],
  index: number | null,
): LiveBoardSummary | null {
  const at = clampBoardIndex(index, boards.length)
  return at === null ? null : boards[at]
}

/** What the panel is showing, and how much of the history it has taken in hand. */
export interface BoardView {
  /** An index into `boards`, or `null` when the conversation has none. */
  index: number | null
  /** The newest board id this view has already accounted for. */
  seen: number | null
}

/** A view of a conversation that has pushed nothing — the panel's start state. */
export function emptyBoardView(): BoardView {
  return { index: null, seen: null }
}

/**
 * The view after a poll lands: the rule that a push replaces what is showing.
 *
 * A board id the view has not seen means the agent pushed while the person
 * was looking at something else, and the panel jumps to the newest — even if
 * they had stepped back through the history, because the board the
 * conversation is *about* is the one that was just pushed. A poll that
 * carries nothing new leaves the step they chose exactly where it was
 * (clamped, since the store's twenty-board retention can prune underneath
 * it), which is what makes stepping back usable at all on a two-second poll.
 *
 * Two states need no case of their own. A conversation that **ended or was
 * cleared** arrives as an empty list and resets the view whole — including
 * `seen`, so the next board is a push rather than something already
 * accounted for. And a **different session** needs nothing either: board ids
 * are one `AUTOINCREMENT` sequence across every conversation, so the first
 * board of the next one is always newer than anything this view saw, and
 * ending the old conversation had already emptied the list.
 */
export function boardViewFor(
  view: BoardView,
  boards: readonly LiveBoardSummary[],
): BoardView {
  const newest = newestBoardId(boards)
  if (newest === null) return emptyBoardView()
  if (view.seen === null || newest > view.seen) {
    // The position of the newest id, not the last element: the route promises
    // oldest-first and the two are the same row, but `newestBoardId` already
    // refuses to trust that order and this must not disagree with it.
    return { index: boards.findIndex((board) => board.id === newest), seen: newest }
  }
  const index = clampBoardIndex(view.index, boards.length)
  // The view it was handed, when nothing moved: the poll runs every two
  // seconds and a fresh object each tick is a render each tick.
  return index === view.index ? view : { index, seen: view.seen }
}

/** Whether the whiteboard panel is showing, and the newest board id the page
 *  has already accounted for. */
export interface BoardPanel {
  seen: number | null
  open: boolean
}

/** A page that has been shown no board yet. */
export function closedBoardPanel(): BoardPanel {
  return { seen: null, open: false }
}

/**
 * Whether a poll's boards open the panel — `nextUnplayed`'s claim-once
 * discipline, in the one shape that fits a picture.
 *
 * A board id the page has not seen means the agent has just pushed something
 * it decided to *show* rather than say, so the panel opens; every later poll
 * carries that same board for as long as the conversation lasts, and without
 * the `seen` half each of them would re-open a panel the person had put away.
 * An empty list — the conversation ended, or its boards were cleared — closes
 * the panel and forgets what was seen, so the next conversation's first board
 * is a push again.
 *
 * Returns the state it was handed, unchanged and by identity, when nothing
 * moved: the caller applies this during render, so "nothing happened" has to
 * be tellable without a comparison of its own.
 */
export function boardPanelFor(
  panel: BoardPanel,
  boards: readonly LiveBoardSummary[],
): BoardPanel {
  const newest = newestBoardId(boards)
  if (newest === null) {
    return panel.seen === null && !panel.open ? panel : closedBoardPanel()
  }
  if (panel.seen === null || newest > panel.seen) return { seen: newest, open: true }
  return panel
}

/**
 * Bringing back a panel the person put away (mesa task 1113).
 *
 * `boardPanelFor` only ever *opens* on a board newer than `seen`, which is
 * what keeps a hidden panel hidden for the rest of the conversation — so
 * reopening cannot go through it, and it must leave `seen` exactly as it was
 * or the next poll would re-open the panel all over again. Returns the state
 * it was handed, by identity, when the panel is already open: the caller
 * holds this in `useState` and a fresh object for a press that changed
 * nothing is a render for nothing, `boardPanelFor`'s own discipline.
 */
export function openBoardPanel(panel: BoardPanel): BoardPanel {
  return panel.open ? panel : { seen: panel.seen, open: true }
}

/**
 * Whether the header offers that press. A conversation that has pushed
 * nothing has no whiteboard to show, so the control is absent rather than
 * dead — and while the panel is up there is nothing to reopen.
 */
export function showsBoardReopen(
  panel: BoardPanel,
  boards: readonly LiveBoardSummary[],
): boolean {
  return boards.length > 0 && !panel.open
}
