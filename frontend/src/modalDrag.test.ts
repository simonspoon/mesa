import { describe, expect, it } from 'vitest'
import { dragOffset } from './modalDrag'

// A 416px (26rem) create-task box on a 1200x800 window: 392px of slack each
// side horizontally, 250px vertically.
const box = { width: 416, height: 300 }
const viewport = { width: 1200, height: 800 }
const centre = { x: 0, y: 0 }

describe('dragOffset', () => {
  it('moves the box by the pointer delta', () => {
    expect(dragOffset(centre, { x: 120, y: -60 }, box, viewport)).toEqual({
      x: 120,
      y: -60,
    })
  })

  it('accumulates from where the previous drag left the box', () => {
    expect(dragOffset({ x: 100, y: 20 }, { x: 30, y: 5 }, box, viewport)).toEqual(
      { x: 130, y: 25 },
    )
  })

  it('stops at the viewport edge instead of letting the box off screen', () => {
    expect(dragOffset(centre, { x: 5000, y: 5000 }, box, viewport)).toEqual({
      x: 392,
      y: 250,
    })
    expect(dragOffset(centre, { x: -5000, y: -5000 }, box, viewport)).toEqual({
      x: -392,
      y: -250,
    })
  })

  it('pins a box that fills the viewport, so a phone sheet cannot move', () => {
    const sheet = { width: 390, height: 844 }
    const phone = { width: 390, height: 844 }
    expect(dragOffset(centre, { x: 200, y: 200 }, sheet, phone)).toEqual({
      x: 0,
      y: 0,
    })
  })

  it('pins a box larger than the viewport rather than inverting its range', () => {
    const tall = { width: 416, height: 1000 }
    expect(dragOffset(centre, { x: 0, y: 300 }, tall, viewport)).toEqual({
      x: 0,
      y: 0,
    })
  })
})
