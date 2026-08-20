import { describe, expect, it } from 'vitest'
import { outerBox, shapeBleed, shapeBleedCss } from './shapeBox'

// The numbers below mirror `App.css`'s backdrop `inset`s on purpose: this file
// is the tripwire for the two drifting apart, which is exactly what mesa task
// 892 fixed (a silhouette nothing else on the canvas knew the size of).

describe('shapeBleed', () => {
  it('gives a generic card no bleed at all', () => {
    expect(shapeBleed(null, 240, 140)).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    })
  })

  it('gives every rectangle-ish shape no bleed', () => {
    for (const shape of [
      'process',
      'start_end',
      'entity',
      'central',
      'idea',
      'scene',
      'predefined_process',
      'weak_entity',
    ] as const) {
      expect(shapeBleed(shape, 240, 140)).toEqual({
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
      })
    }
  })

  it('scales the diamond with the card it wraps', () => {
    expect(shapeBleed('decision', 240, 140)).toEqual({
      top: 49,
      right: 48,
      bottom: 49,
      left: 48,
    })
    // A card twice as tall bleeds twice as far, because the backdrop's inset
    // is a percentage — the reason a fixed px table would have been wrong.
    expect(shapeBleed('decision', 240, 280).top).toBe(98)
  })

  it('treats the ERD relationship diamond exactly as the decision one', () => {
    expect(shapeBleed('relationship', 240, 140)).toEqual(
      shapeBleed('decision', 240, 140),
    )
  })

  it('keeps the fixed silhouette details in px, whatever the card measures', () => {
    expect(shapeBleed('data', 240, 140)).toEqual({
      top: 6,
      right: 28,
      bottom: 6,
      left: 28,
    })
    expect(shapeBleed('data', 900, 900)).toEqual(shapeBleed('data', 240, 140))
    // The document's wave hangs off the bottom only.
    expect(shapeBleed('document', 240, 140)).toEqual({
      top: 6,
      right: 6,
      bottom: 28,
      left: 6,
    })
    // The cylinder's caps are vertical; the note's fold is to the right.
    expect(shapeBleed('database', 240, 140)).toEqual({
      top: 22,
      right: 10,
      bottom: 22,
      left: 10,
    })
    expect(shapeBleed('note', 240, 140)).toEqual({
      top: 8,
      right: 26,
      bottom: 8,
      left: 8,
    })
  })
})

describe('outerBox', () => {
  it('returns the card\'s own box for an unshaped frame', () => {
    const box = { x: 10, y: 20, w: 240, h: 140 }
    expect(outerBox(box, null)).toEqual(box)
    expect(outerBox(box, 'process')).toEqual(box)
  })

  it('grows a shaped box outward on every bleeding side', () => {
    expect(outerBox({ x: 100, y: 100, w: 240, h: 140 }, 'decision')).toEqual({
      x: 52,
      y: 51,
      w: 336,
      h: 238,
    })
  })

  it('stays centred on the card it wraps', () => {
    const box = { x: 100, y: 100, w: 240, h: 140 }
    const out = outerBox(box, 'attribute')
    expect(out.x + out.w / 2).toBeCloseTo(box.x + box.w / 2)
    expect(out.y + out.h / 2).toBeCloseTo(box.y + box.h / 2)
  })

  it('grows only downward for the document wave', () => {
    const out = outerBox({ x: 0, y: 0, w: 240, h: 140 }, 'document')
    expect(out.y).toBe(-6)
    expect(out.h).toBe(140 + 6 + 28)
  })
})

describe('shapeBleedCss', () => {
  it('leaves an unshaped frame to React Flow\'s own handle positioning', () => {
    expect(shapeBleedCss(null)).toBeNull()
    expect(shapeBleedCss('process')).toBeNull()
  })

  it('keeps a proportional bleed a percentage and a fixed one px', () => {
    expect(shapeBleedCss('decision')).toEqual({
      top: '35%',
      right: '20%',
      bottom: '35%',
      left: '20%',
    })
    expect(shapeBleedCss('data')).toEqual({
      top: '6px',
      right: '28px',
      bottom: '6px',
      left: '28px',
    })
  })

  it('agrees with shapeBleed on a 100x100 card', () => {
    // The percentage is of the card's own width/height, so at 100x100 the two
    // forms have to name the same number — the check that the CSS path and
    // the px path cannot drift.
    const px = shapeBleed('attribute', 100, 100)
    const css = shapeBleedCss('attribute')!
    expect(css.top).toBe(`${px.top}%`)
    expect(css.left).toBe(`${px.left}%`)
  })
})
