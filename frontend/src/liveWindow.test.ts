import { describe, expect, it } from 'vitest'
import { sameBox, windowBox, type WindowBoxSource } from './liveWindow'
import type { LiveWindow } from './types/LiveWindow'

function source(over: Partial<WindowBoxSource> = {}): WindowBoxSource {
  return { screenX: 22, screenY: 22, outerWidth: 1600, outerHeight: 1000, ...over }
}

function box(over: Partial<LiveWindow> = {}): LiveWindow {
  return { x: 22, y: 22, width: 1600, height: 1000, ...over }
}

describe('windowBox', () => {
  it('reports the four values the window knows about itself', () => {
    expect(windowBox(source())).toEqual(box())
  })

  it('rounds every field, because loki reports floats and the two are matched for equality', () => {
    expect(
      windowBox({ screenX: 21.6, screenY: 22.4, outerWidth: 1599.5, outerHeight: 999.49 }),
    ).toEqual(box({ x: 22, y: 22, width: 1600, height: 999 }))
  })

  it('a window pushed off the left edge keeps its negative origin', () => {
    expect(windowBox(source({ screenX: -400.2 }))?.x).toBe(-400)
  })
})

describe('sameBox', () => {
  it('two absences are the same', () => {
    expect(sameBox(null, null)).toBe(true)
  })

  it('an absence and a box are not', () => {
    expect(sameBox(null, box())).toBe(false)
    expect(sameBox(box(), null)).toBe(false)
  })

  it('equal fields on distinct objects are the same window in the same place', () => {
    expect(sameBox(box(), box())).toBe(true)
  })

  it('any one field differing is a difference', () => {
    expect(sameBox(box(), box({ x: 23 }))).toBe(false)
    expect(sameBox(box(), box({ y: 23 }))).toBe(false)
    expect(sameBox(box(), box({ width: 1601 }))).toBe(false)
    expect(sameBox(box(), box({ height: 1001 }))).toBe(false)
  })

  it('a resize and a move are both differences', () => {
    const moved = windowBox(source({ screenX: 400, screenY: 120 }))
    const resized = windowBox(source({ outerWidth: 1200 }))
    expect(sameBox(windowBox(source()), moved)).toBe(false)
    expect(sameBox(windowBox(source()), resized)).toBe(false)
  })
})
