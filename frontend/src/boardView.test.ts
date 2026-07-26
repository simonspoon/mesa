import { beforeEach, describe, expect, it } from 'vitest'
import { loadBoardView, saveBoardView } from './boardView'

describe('boardView', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns null when nothing is stored for the board', () => {
    expect(loadBoardView(7)).toBeNull()
  })

  it('round-trips a saved view unchanged', () => {
    const view = { tx: -120.5, ty: 40, scale: 1.25 }
    saveBoardView(7, view)
    expect(loadBoardView(7)).toEqual(view)
  })

  it('keys storage per board', () => {
    saveBoardView(7, { tx: 1, ty: 2, scale: 3 })
    expect(loadBoardView(8)).toBeNull()
  })

  it('falls back to null on unparseable JSON', () => {
    localStorage.setItem('mesa-board-view-7', 'not json{')
    expect(loadBoardView(7)).toBeNull()
  })

  it.each([
    ['a missing key', '{"tx":1,"ty":2}'],
    ['a non-numeric member', '{"tx":1,"ty":2,"scale":"1.5"}'],
    ['a non-object', '42'],
    ['null', 'null'],
  ])('falls back to null on %s', (_label, raw) => {
    localStorage.setItem('mesa-board-view-7', raw)
    expect(loadBoardView(7)).toBeNull()
  })
})
