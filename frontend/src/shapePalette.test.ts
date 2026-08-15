import { describe, expect, it } from 'vitest'
import { SHAPES_FOR_TYPE } from './diagramOptions'
import {
  DEFAULT_FRAME_H,
  DEFAULT_FRAME_W,
  GENERIC_TOKEN,
  decodeShapeDrag,
  dropPosition,
  encodeShapeDrag,
  paletteItems,
} from './shapePalette'
import type { DiagramType } from './types/DiagramType'

const TYPES: DiagramType[] = ['storyboard', 'flowchart', 'erd', 'brainstorm']

describe('paletteItems', () => {
  it('offers exactly the board type shape set, in offer order', () => {
    for (const type of TYPES) {
      expect(paletteItems(type).map((i) => i.shape)).toEqual(
        SHAPES_FOR_TYPE[type],
      )
    }
  })

  it('names the generic card "frame" and every shape by its own label', () => {
    const storyboard = paletteItems('storyboard')
    expect(storyboard[0]).toEqual({
      key: GENERIC_TOKEN,
      shape: null,
      label: 'frame',
    })
    expect(paletteItems('flowchart')[2]).toEqual({
      key: 'start_end',
      shape: 'start_end',
      label: 'start/end',
    })
  })

  it('gives every row a distinct, non-empty key and label', () => {
    for (const type of TYPES) {
      const items = paletteItems(type)
      expect(new Set(items.map((i) => i.key)).size).toBe(items.length)
      for (const item of items) {
        expect(item.key).not.toBe('')
        expect(item.label).not.toBe('')
      }
    }
  })
})

describe('encode/decode round trip', () => {
  it('round-trips every shape a board offers, generic card included', () => {
    for (const type of TYPES) {
      for (const shape of SHAPES_FOR_TYPE[type]) {
        expect(decodeShapeDrag(encodeShapeDrag(shape), type)).toEqual({ shape })
      }
    }
  })

  it('distinguishes the generic card from a rejected drop', () => {
    // `{shape: null}` is a real create; `null` is "not a shape drop".
    expect(decodeShapeDrag(GENERIC_TOKEN, 'storyboard')).toEqual({ shape: null })
    expect(decodeShapeDrag(GENERIC_TOKEN, 'flowchart')).toBeNull()
  })
})

describe('decodeShapeDrag', () => {
  it('rejects a payload this board type does not offer', () => {
    expect(decodeShapeDrag('entity', 'flowchart')).toBeNull()
    expect(decodeShapeDrag('decision', 'erd')).toBeNull()
    // ...but the same token on its own board is honoured.
    expect(decodeShapeDrag('entity', 'erd')).toEqual({ shape: 'entity' })
  })

  it('rejects foreign, empty and missing payloads', () => {
    expect(decodeShapeDrag(null, 'flowchart')).toBeNull()
    expect(decodeShapeDrag(undefined, 'flowchart')).toBeNull()
    expect(decodeShapeDrag('', 'flowchart')).toBeNull()
    expect(decodeShapeDrag('   ', 'flowchart')).toBeNull()
    expect(decodeShapeDrag('file:///etc/passwd', 'flowchart')).toBeNull()
    expect(decodeShapeDrag('__proto__', 'flowchart')).toBeNull()
  })

  it('tolerates the whitespace a dataTransfer round trip can add', () => {
    expect(decodeShapeDrag(' process\n', 'flowchart')).toEqual({
      shape: 'process',
    })
  })
})

describe('dropPosition', () => {
  it('centres the default-sized frame under the drop point', () => {
    expect(dropPosition({ x: 500, y: 300 })).toEqual({
      x: 500 - DEFAULT_FRAME_W / 2,
      y: 300 - DEFAULT_FRAME_H / 2,
    })
  })

  it('rounds, and keeps negative canvas coordinates', () => {
    expect(dropPosition({ x: 10.4, y: -20.6 })).toEqual({ x: -110, y: -91 })
  })
})
