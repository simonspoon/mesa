import { describe, expect, it } from 'vitest'
import { boardViewFor, emptyBoardView } from './liveBoard'
import {
  addStroke,
  base64Bytes,
  boardInk,
  clearInk,
  emptyInkBook,
  framePoint,
  frozenBoard,
  heldBoardView,
  inkBackground,
  inkCaption,
  inkCarrier,
  inkIsNew,
  markInkSent,
  pendingInk,
  pruneInk,
  undoStroke,
  type InkFrame,
  type InkStroke,
} from './liveInk'
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

const FRAME: InkFrame = { width: 600, height: 400, scrollLeft: 0, scrollTop: 120 }
const LATER: InkFrame = { width: 900, height: 700, scrollLeft: 0, scrollTop: 0 }

function stroke(x: number): InkStroke {
  return [
    { x, y: 1 },
    { x: x + 1, y: 2 },
  ]
}

describe('strokes', () => {
  it('adds, undoes and clears, one board at a time', () => {
    const a = stroke(1)
    const b = stroke(2)
    let book = addStroke(emptyInkBook(), 7, a, FRAME)
    book = addStroke(book, 7, b, FRAME)
    expect(boardInk(book, 7).strokes).toEqual([a, b])
    expect(boardInk(book, 8).strokes).toEqual([])
    book = undoStroke(book, 7, LATER)
    expect(boardInk(book, 7).strokes).toEqual([a])
    book = clearInk(book, 7)
    expect(boardInk(book, 7).strokes).toEqual([])
    expect(frozenBoard(book)).toBeNull()
  })

  it('ignores a stroke with no points and an undo with nothing to undo', () => {
    const book = emptyInkBook()
    expect(addStroke(book, 7, [], FRAME)).toBe(book)
    expect(undoStroke(book, 7, FRAME)).toBe(book)
    expect(clearInk(book, 7)).toBe(book)
  })
})

describe('the dirty flag and the freeze', () => {
  it('freezes at the frame of the first new stroke and keeps it', () => {
    let book = addStroke(emptyInkBook(), 7, stroke(1), FRAME)
    book = addStroke(book, 7, stroke(2), LATER)
    expect(boardInk(book, 7).frame).toEqual(FRAME)
    expect(frozenBoard(book)).toBe(7)
  })

  it('is clean again once every unsent stroke is undone', () => {
    let book = addStroke(emptyInkBook(), 7, stroke(1), FRAME)
    book = undoStroke(book, 7, LATER)
    expect(inkIsNew(boardInk(book, 7))).toBe(false)
    expect(frozenBoard(book)).toBeNull()
    expect(pendingInk(book)).toBeNull()
  })

  it('is cleared by a send that carried it, and the layout unfreezes', () => {
    let book = addStroke(emptyInkBook(), 7, stroke(1), FRAME)
    const pending = pendingInk(book)
    expect(pending?.boardId).toBe(7)
    book = markInkSent(book, 7, pending!.strokes)
    expect(pendingInk(book)).toBeNull()
    expect(boardInk(book, 7).frame).toBeNull()
    // Sent ink stays drawn.
    expect(boardInk(book, 7).strokes).toHaveLength(1)
  })

  it('stays dirty when the person drew more while the turn was on its way', () => {
    let book = addStroke(emptyInkBook(), 7, stroke(1), FRAME)
    const sent = pendingInk(book)!.strokes
    book = addStroke(book, 7, stroke(2), LATER)
    book = markInkSent(book, 7, sent)
    expect(frozenBoard(book)).toBe(7)
    expect(boardInk(book, 7).frame).toEqual(FRAME)
    expect(pendingInk(book)?.strokes).toHaveLength(2)
  })

  it('stays dirty when the send failed — nothing marks it', () => {
    const book = addStroke(emptyInkBook(), 7, stroke(1), FRAME)
    expect(pendingInk(book)).not.toBeNull()
  })

  it('treats undoing a stroke the agent saw as new, freezing where it stands', () => {
    let book = addStroke(emptyInkBook(), 7, stroke(1), FRAME)
    book = markInkSent(book, 7, pendingInk(book)!.strokes)
    book = undoStroke(book, 7, LATER)
    expect(frozenBoard(book)).toBe(7)
    expect(boardInk(book, 7).frame).toEqual(LATER)
  })

  it('does not refreeze a board cleared while its turn was on its way', () => {
    let book = addStroke(emptyInkBook(), 7, stroke(1), FRAME)
    const sent = pendingInk(book)!.strokes
    book = clearInk(book, 7)
    const after = markInkSent(book, 7, sent)
    expect(after).toBe(book)
    expect(frozenBoard(after)).toBeNull()
  })
})

describe('pruneInk', () => {
  it('drops ink on boards that are gone and keeps the rest', () => {
    let book = addStroke(emptyInkBook(), 7, stroke(1), FRAME)
    book = addStroke(book, 8, stroke(2), FRAME)
    const pruned = pruneInk(book, [board(8)])
    expect(Object.keys(pruned)).toEqual(['8'])
    expect(pruneInk(pruned, [board(8), board(9)])).toBe(pruned)
    expect(pruneInk(pruned, [])).toEqual({})
  })
})

describe('heldBoardView', () => {
  it('does not advance to a newly pushed board while one is frozen', () => {
    const view = boardViewFor(emptyBoardView(), [board(1), board(2)])
    expect(view.index).toBe(1)
    const pushed = [board(1), board(2), board(3)]
    const held = heldBoardView(view, pushed, 2)
    expect(held.index).toBe(1)
    expect(held.seen).toBe(2)
    // Released: the ordinary rule shows the newest.
    const released = heldBoardView(held, pushed, null)
    expect(released).toEqual({ index: 2, seen: 3 })
  })

  it('follows the held board by id when a push prunes the oldest', () => {
    const view = { index: 1, seen: 2 }
    const held = heldBoardView(view, [board(2), board(3)], 2)
    expect(held.index).toBe(0)
  })

  it('is the ordinary rule when the held board is gone', () => {
    const view = { index: 0, seen: 1 }
    expect(heldBoardView(view, [board(3)], 1)).toEqual({ index: 0, seen: 3 })
  })

  it('answers the same view when nothing moved', () => {
    const view = { index: 1, seen: 2 }
    expect(heldBoardView(view, [board(1), board(2)], 2)).toBe(view)
  })
})

describe('inkCarrier', () => {
  it('puts the ink on the last turn of a flush', () => {
    expect(inkCarrier(1)).toBe(0)
    expect(inkCarrier(3)).toBe(2)
    expect(inkCarrier(0)).toBeNull()
  })
})

describe('backgrounds', () => {
  it('reads each kind the one way it can be read', () => {
    expect(inkBackground('image')).toBe('image')
    expect(inkBackground('diagram')).toBe('svg')
    expect(inkBackground('markdown')).toBe('dom')
    expect(inkBackground('html')).toBe('caption')
    expect(inkBackground('whatever' as never)).toBe('caption')
  })

  it('captions a board by its title and kind', () => {
    expect(inkCaption(board(4, { kind: 'html', title: 'Mockup' }))).toBe('Mockup · html')
    expect(inkCaption(board(4, { kind: 'html', title: null }))).toBe('Board 4 · html')
  })
})

describe('framePoint', () => {
  it('moves a content point into the frozen frame', () => {
    expect(framePoint({ x: 10, y: 150 }, FRAME)).toEqual({ x: 10, y: 30 })
  })
})

describe('base64Bytes', () => {
  it('counts decoded bytes, padding included', () => {
    expect(base64Bytes(btoa('abc'))).toBe(3)
    expect(base64Bytes(btoa('ab'))).toBe(2)
    expect(base64Bytes(btoa('a'))).toBe(1)
  })
})
