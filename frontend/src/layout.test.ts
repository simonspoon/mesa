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

  it('centres a thin layer on the widest one', () => {
    // 1 forks to 2 and 3, which rejoin at 4 (mesa task 892). Layer 1 is two
    // frames wide; layers 0 and 2 hold one each. Packed against ORIGIN the
    // trunk ran down the left edge of the fork and every connector to it
    // arrived at a slant; centred, 1 and 4 sit on the fork's own centre line.
    const pos = layoutFrames(
      [frame(1), frame(2), frame(3), frame(4)],
      [edge(1, 2), edge(1, 3), edge(2, 4), edge(3, 4)],
      'vertical',
    )
    const forkWidth = 2 * W + GAP_NODE
    const centred = ORIGIN + Math.round((forkWidth - W) / 2)
    expect(pos.get(1)!.x).toBe(centred)
    expect(pos.get(4)!.x).toBe(centred)
    // The widest layer still starts exactly at ORIGIN.
    expect(pos.get(2)!.x).toBe(ORIGIN)
    expect(pos.get(3)!.x).toBe(ORIGIN + W + GAP_NODE)
    // ...and 1 is centred on the pair it feeds.
    expect(pos.get(1)!.x + W / 2).toBe(ORIGIN + forkWidth / 2)
  })

  it('centres the same fork across the other axis when horizontal', () => {
    const pos = layoutFrames(
      [frame(1), frame(2), frame(3), frame(4)],
      [edge(1, 2), edge(1, 3), edge(2, 4), edge(3, 4)],
      'horizontal',
    )
    const forkHeight = 2 * H + GAP_NODE
    expect(pos.get(1)!.y).toBe(ORIGIN + Math.round((forkHeight - H) / 2))
    expect(pos.get(1)!.y).toBe(pos.get(4)!.y)
    expect(pos.get(2)!.y).toBe(ORIGIN)
  })

  it('reserves a channel for an edge that spans more than one layer', () => {
    // 1 -> 2 -> 3 and 1 -> 3 (mesa task 892). The long edge crosses layer 1,
    // where 2 sits alone; without a dummy there the connector was drawn
    // straight over 2's card. The dummy takes no size, so what it buys is the
    // GAP_NODE on each side of it — layer 1 is now the width of 2 plus one
    // whole gap, and 2 no longer sits on the line between 1 and 3.
    const pos = layoutFrames(
      [frame(1), frame(2), frame(3)],
      [edge(1, 2), edge(2, 3), edge(1, 3)],
      'vertical',
    )
    // Only real frames come back.
    expect([...pos.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3])
    // Layer 1 is [2, dummy] — 2 keeps the left slot, the channel is to its
    // right — and layers 0 and 2 centre on that combined extent.
    const layer1Extent = W + GAP_NODE
    const centred = ORIGIN + Math.round((layer1Extent - W) / 2)
    expect(pos.get(2)!.x).toBe(ORIGIN)
    expect(pos.get(1)!.x).toBe(centred)
    expect(pos.get(3)!.x).toBe(centred)
  })

  it('does not reserve a channel for an edge between neighbouring layers', () => {
    // The plain chain must be byte-identical to before dummies existed.
    const pos = layoutFrames(
      [frame(1), frame(2), frame(3)],
      [edge(1, 2), edge(2, 3)],
      'vertical',
    )
    expect(pos.get(1)).toEqual({ x: ORIGIN, y: ORIGIN })
    expect(pos.get(2)).toEqual({ x: ORIGIN, y: ORIGIN + H + GAP_LAYER })
    expect(pos.get(3)).toEqual({ x: ORIGIN, y: ORIGIN + 2 * (H + GAP_LAYER) })
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
