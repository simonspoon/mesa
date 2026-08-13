import { describe, expect, it } from 'vitest'
import { layoutFrames } from './layout'
import type { LayoutEdge, LayoutFrame } from './layout'

// Mirrors the module's own constants; a change to either is meant to show up
// here as a failing coordinate rather than silently reflowing every board.
const ORIGIN = 48
const GAP_LAYER = 80
const GAP_NODE = 40

const W = 100
const H = 50

const frame = (id: number, w = W, h = H): LayoutFrame => ({ id, w, h })
const edge = (from_frame: number, to_frame: number): LayoutEdge => ({
  from_frame,
  to_frame,
})

describe('layoutFrames', () => {
  it('lays out nothing for no frames', () => {
    expect(layoutFrames([], [], 'vertical').size).toBe(0)
  })

  it('puts a lone frame at the origin', () => {
    const pos = layoutFrames([frame(1)], [], 'vertical')
    expect(pos.get(1)).toEqual({ x: ORIGIN, y: ORIGIN })
  })

  it('spreads unconnected frames across one layer', () => {
    const pos = layoutFrames([frame(1), frame(2)], [], 'vertical')
    expect(pos.get(1)).toEqual({ x: ORIGIN, y: ORIGIN })
    expect(pos.get(2)).toEqual({ x: ORIGIN + W + GAP_NODE, y: ORIGIN })
  })

  it('stacks a chain top-to-bottom when vertical', () => {
    const pos = layoutFrames([frame(1), frame(2)], [edge(1, 2)], 'vertical')
    expect(pos.get(1)).toEqual({ x: ORIGIN, y: ORIGIN })
    expect(pos.get(2)).toEqual({ x: ORIGIN, y: ORIGIN + H + GAP_LAYER })
  })

  it('stacks the same chain left-to-right when horizontal', () => {
    const pos = layoutFrames([frame(1), frame(2)], [edge(1, 2)], 'horizontal')
    expect(pos.get(1)).toEqual({ x: ORIGIN, y: ORIGIN })
    expect(pos.get(2)).toEqual({ x: ORIGIN + W + GAP_LAYER, y: ORIGIN })
  })

  it('offsets the next layer by the tallest frame in the previous one', () => {
    const pos = layoutFrames(
      [frame(1, W, 50), frame(2, W, 120), frame(3)],
      [edge(1, 3)],
      'vertical',
    )
    // Frames 1 and 2 share layer 0; the layer's depth is the taller of them.
    expect(pos.get(3)!.y).toBe(ORIGIN + 120 + GAP_LAYER)
  })

  it('ranks by longest path, not by first path found', () => {
    // 1 -> 2 -> 3 and 1 -> 3: frame 3 must sit below 2, not beside it.
    const pos = layoutFrames(
      [frame(1), frame(2), frame(3)],
      [edge(1, 2), edge(2, 3), edge(1, 3)],
      'vertical',
    )
    expect(pos.get(1)!.y).toBe(ORIGIN)
    expect(pos.get(2)!.y).toBe(ORIGIN + H + GAP_LAYER)
    expect(pos.get(3)!.y).toBe(ORIGIN + 2 * (H + GAP_LAYER))
  })

  it('terminates on a cycle by dropping the back edge', () => {
    // Diagram edges may legitimately form cycles — this is a drawing, not
    // a dependency graph, so the layout must rank rather than throw or hang.
    const pos = layoutFrames(
      [frame(1), frame(2), frame(3)],
      [edge(1, 2), edge(2, 3), edge(3, 1)],
      'vertical',
    )
    expect([...pos.keys()].sort()).toEqual([1, 2, 3])
    expect(pos.get(1)!.y).toBe(ORIGIN)
    expect(pos.get(3)!.y).toBe(ORIGIN + 2 * (H + GAP_LAYER))
  })

  it('ignores a self-edge', () => {
    const pos = layoutFrames([frame(1)], [edge(1, 1)], 'vertical')
    expect(pos.get(1)).toEqual({ x: ORIGIN, y: ORIGIN })
  })

  it('ignores an edge naming a frame that is not being laid out', () => {
    const pos = layoutFrames([frame(1), frame(2)], [edge(1, 99)], 'vertical')
    expect(pos.get(1)).toEqual({ x: ORIGIN, y: ORIGIN })
    expect(pos.get(2)).toEqual({ x: ORIGIN + W + GAP_NODE, y: ORIGIN })
    expect(pos.has(99)).toBe(false)
  })

  it('orders a layer by its predecessors to reduce crossings', () => {
    // Layer 0 is [1, 2] in input order. Layer 1 holds 3 (fed by 2) and 4 (fed
    // by 1); following input order would cross the two edges, so the
    // barycenter puts 4 first.
    const pos = layoutFrames(
      [frame(1), frame(2), frame(3), frame(4)],
      [edge(2, 3), edge(1, 4)],
      'vertical',
    )
    expect(pos.get(4)!.x).toBe(ORIGIN)
    expect(pos.get(3)!.x).toBe(ORIGIN + W + GAP_NODE)
  })
})
