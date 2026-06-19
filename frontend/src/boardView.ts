// Per-board canvas view state (pan + zoom), persisted browser-local so each
// storyboard reopens at the pan/zoom the user left it. This lives only on the
// user's machine (localStorage), keyed by board id — never on the board/server
// and never shared across devices, matching the author-id pattern in author.ts.

const KEY = (storyboardId: number) => `mesa-board-view-${storyboardId}`

/** The pan/zoom transform applied to the canvas content layer. Mirrors the
 *  `ViewTransform` shape in StoryboardCanvas; kept structural so a saved view
 *  round-trips unchanged. */
export type BoardView = {
  tx: number
  ty: number
  scale: number
}

/** Load the saved view for a board, or null if none is stored / it is
 *  unreadable. Validates the shape so a corrupt entry falls back to the
 *  default rather than throwing. */
export function loadBoardView(storyboardId: number): BoardView | null {
  const raw = localStorage.getItem(KEY(storyboardId))
  if (raw === null) return null
  try {
    const v = JSON.parse(raw) as unknown
    if (
      typeof v === 'object' &&
      v !== null &&
      typeof (v as BoardView).tx === 'number' &&
      typeof (v as BoardView).ty === 'number' &&
      typeof (v as BoardView).scale === 'number'
    ) {
      return v as BoardView
    }
  } catch {
    // Corrupt entry — fall through to the default.
  }
  return null
}

export function saveBoardView(storyboardId: number, view: BoardView): void {
  localStorage.setItem(KEY(storyboardId), JSON.stringify(view))
}
