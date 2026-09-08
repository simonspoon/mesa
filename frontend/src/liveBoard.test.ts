import { describe, expect, it } from 'vitest'
import {
  boardAt,
  boardPanelFor,
  boardRender,
  boardTitle,
  boardViewFor,
  clampBoardIndex,
  closedBoardPanel,
  emptyBoardView,
  newestBoardId,
  openBoardPanel,
  showsBoardReopen,
  stepBoard,
} from './liveBoard'
import type { LiveBoardSummary } from './types/LiveBoardSummary'

function board(id: number, patch: Partial<LiveBoardSummary> = {}): LiveBoardSummary {
  return {
    id,
    session_id: 1,
    kind: 'markdown',
    title: 'the plan',
    created_at: '2026-01-01 00:00:00',
    ...patch,
  }
}

describe('boardRender', () => {
  it('renders markdown itself and frames the two document kinds', () => {
    expect(boardRender('markdown')).toBe('markdown')
    expect(boardRender('html')).toBe('frame')
    expect(boardRender('diagram')).toBe('frame')
    expect(boardRender('image')).toBe('image')
  })

  it('frames a kind it does not know', () => {
    // A newer server's kind must land on the sandboxed branch, never on the
    // one that renders in mesa's own DOM.
    expect(boardRender('svg-canvas' as never)).toBe('frame')
  })
})

describe('boardTitle', () => {
  it('is the title the agent gave it', () => {
    expect(boardTitle(board(3, { title: 'the plan' }))).toBe('the plan')
    expect(boardTitle(board(3, { title: '  the plan  ' }))).toBe('the plan')
  })

  it('names the board itself when there is no title', () => {
    // Pushing mid-sentence carries no title, and a blank head reads as broken.
    expect(boardTitle(board(3, { title: null }))).toBe('Board 3')
    expect(boardTitle(board(3, { title: '   ' }))).toBe('Board 3')
  })
})

describe('newestBoardId', () => {
  it('is the highest id in the history', () => {
    expect(newestBoardId([board(4), board(7)])).toBe(7)
  })

  it('does not trust the order it was given', () => {
    expect(newestBoardId([board(9), board(4)])).toBe(9)
  })

  it('is null for a conversation that has pushed nothing', () => {
    expect(newestBoardId([])).toBeNull()
  })
})

describe('clampBoardIndex', () => {
  it('leaves an index that is already in range', () => {
    expect(clampBoardIndex(1, 3)).toBe(1)
  })

  it('takes the newest when nothing has been chosen', () => {
    // "Nothing chosen" and "what is showing" are the same state.
    expect(clampBoardIndex(null, 3)).toBe(2)
  })

  it('clamps at both ends rather than wrapping', () => {
    expect(clampBoardIndex(-2, 3)).toBe(0)
    expect(clampBoardIndex(9, 3)).toBe(2)
  })

  it('is null when there is nothing to show', () => {
    expect(clampBoardIndex(0, 0)).toBeNull()
    expect(clampBoardIndex(null, 0)).toBeNull()
  })
})

describe('stepBoard', () => {
  it('steps back and forward through the history', () => {
    expect(stepBoard(2, -1, 3)).toBe(1)
    expect(stepBoard(1, 1, 3)).toBe(2)
  })

  it('stops at each end', () => {
    expect(stepBoard(0, -1, 3)).toBe(0)
    expect(stepBoard(2, 1, 3)).toBe(2)
  })

  it('steps from the newest when nothing has been chosen', () => {
    expect(stepBoard(null, -1, 3)).toBe(1)
  })

  it('has nowhere to go with no boards', () => {
    expect(stepBoard(null, -1, 0)).toBeNull()
    expect(stepBoard(0, 1, 0)).toBeNull()
  })
})

describe('boardAt', () => {
  it('is the board an index names', () => {
    expect(boardAt([board(4), board(7)], 0)?.id).toBe(4)
  })

  it('answers the newest for an unchosen index, and null for none', () => {
    expect(boardAt([board(4), board(7)], null)?.id).toBe(7)
    expect(boardAt([], 2)).toBeNull()
  })

  it('survives an index the pruning outran', () => {
    expect(boardAt([board(4), board(7)], 5)?.id).toBe(7)
  })
})

describe('boardViewFor', () => {
  it('shows the first board a conversation pushes', () => {
    expect(boardViewFor(emptyBoardView(), [board(4)])).toEqual({ index: 0, seen: 4 })
  })

  it('jumps to the newest on a push, even from a step back', () => {
    // Each push replaces what is showing: the board just pushed is the one the
    // conversation is about, and an old one left up is a picture nobody is
    // talking about.
    const stepped = { index: 0, seen: 7 }
    expect(boardViewFor(stepped, [board(4), board(7), board(9)])).toEqual({
      index: 2,
      seen: 9,
    })
  })

  it('leaves a step back alone while nothing is pushed', () => {
    // The poll runs every two seconds; a view that reset on each of them would
    // make stepping back impossible.
    const stepped = { index: 0, seen: 7 }
    expect(boardViewFor(stepped, [board(4), board(7)])).toEqual({
      index: 0,
      seen: 7,
    })
  })

  it('clamps a held index the retention outran', () => {
    // The store keeps the newest twenty; a step back can outlive its row.
    expect(boardViewFor({ index: 5, seen: 7 }, [board(4), board(7)])).toEqual({
      index: 1,
      seen: 7,
    })
  })

  it('resets whole when the conversation ends or is cleared', () => {
    // An ended session polls as no boards at all. `seen` has to go with the
    // index, or the next conversation's first board reads as already accounted
    // for and the panel never opens for it.
    expect(boardViewFor({ index: 1, seen: 7 }, [])).toEqual({
      index: null,
      seen: null,
    })
  })

  it('treats the next conversation’s first board as a push', () => {
    // Board ids are one AUTOINCREMENT sequence across sessions, so a new
    // session needs no case of its own — this is the state after the reset
    // above, and the id is newer than anything the old conversation had.
    const ended = boardViewFor({ index: 1, seen: 7 }, [])
    expect(boardViewFor(ended, [board(31, { session_id: 2 })])).toEqual({
      index: 0,
      seen: 31,
    })
  })

  it('finds the newest wherever in the list it arrived', () => {
    expect(boardViewFor(emptyBoardView(), [board(9), board(4)])).toEqual({
      index: 0,
      seen: 9,
    })
  })
})

describe('boardPanelFor', () => {
  it('opens on a board the page has not been shown', () => {
    expect(boardPanelFor(closedBoardPanel(), [board(4)])).toEqual({
      seen: 4,
      open: true,
    })
  })

  it('opens again on the next push', () => {
    expect(boardPanelFor({ seen: 4, open: false }, [board(4), board(7)])).toEqual({
      seen: 7,
      open: true,
    })
  })

  it('leaves a panel the person closed shut', () => {
    // The board stays in the poll for the rest of the conversation; without
    // the `seen` half every two seconds would re-open it.
    const closed = { seen: 7, open: false }
    expect(boardPanelFor(closed, [board(4), board(7)])).toBe(closed)
  })

  it('answers by identity when nothing moved', () => {
    // The caller applies this during render, so a fresh object each tick would
    // be a render each tick — and, with no comparison of its own, a loop.
    const open = { seen: 7, open: true }
    expect(boardPanelFor(open, [board(7)])).toBe(open)
    const cold = closedBoardPanel()
    expect(boardPanelFor(cold, [])).toBe(cold)
  })

  it('closes and forgets when the conversation ends or is cleared', () => {
    expect(boardPanelFor({ seen: 7, open: true }, [])).toEqual({
      seen: null,
      open: false,
    })
  })
})

describe('openBoardPanel', () => {
  it('reopens a panel the person hid, without moving `seen`', () => {
    // Reopening is not a push: touching `seen` here would make the next poll
    // treat the same board as new and re-open the panel on its own.
    expect(openBoardPanel({ seen: 7, open: false })).toEqual({ seen: 7, open: true })
  })

  it('answers by identity when the panel is already open', () => {
    const open = { seen: 7, open: true }
    expect(openBoardPanel(open)).toBe(open)
  })

  it('leaves the seen-once rule intact for the polls that follow', () => {
    // The regression this guards: hide, reopen, and the two-second poll still
    // carries the same newest board — it must go on changing nothing, so a
    // later hide stays a hide.
    const reopened = openBoardPanel({ seen: 7, open: false })
    expect(boardPanelFor(reopened, [board(4), board(7)])).toBe(reopened)
    const hiddenAgain = { seen: 7, open: false }
    expect(boardPanelFor(hiddenAgain, [board(4), board(7)])).toBe(hiddenAgain)
  })
})

describe('showsBoardReopen', () => {
  it('is offered only while a hidden panel has something to show', () => {
    expect(showsBoardReopen({ seen: 7, open: false }, [board(7)])).toBe(true)
  })

  it('is absent with no boards, and while the panel is up', () => {
    // A conversation that has pushed nothing has no whiteboard at all, so the
    // control is missing rather than dead.
    expect(showsBoardReopen(closedBoardPanel(), [])).toBe(false)
    expect(showsBoardReopen({ seen: 7, open: true }, [board(7)])).toBe(false)
  })
})
