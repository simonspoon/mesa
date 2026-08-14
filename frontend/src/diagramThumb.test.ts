import { describe, expect, it } from 'vitest'
import { diagramThumb } from './diagramThumb'
import type { Frame } from './types/Frame'
import type { FrameEdge } from './types/FrameEdge'

function frame(f: Partial<Frame> & { id: number }): Frame {
  return {
    diagram_id: 1,
    title: '',
    body: null,
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    color: null,
    task_id: null,
    author: null,
    shape: null,
    created_at: '2026-08-13 00:00:00',
    updated_at: '2026-08-13 00:00:00',
    ...f,
  }
}

function edge(e: Partial<FrameEdge> & { id: number }): FrameEdge {
  return {
    diagram_id: 1,
    from_frame: 1,
    to_frame: 2,
    label: null,
    author: null,
    created_at: '2026-08-13 00:00:00',
    waypoints: [],
    from_anchor: null,
    to_anchor: null,
    style: null,
    from_marker: null,
    to_marker: null,
    ...e,
  }
}

describe('diagramThumb', () => {
  it('answers null for a board with no frames', () => {
    expect(diagramThumb([], [], 96, 64)).toBeNull()
    // An edge can't exist without its frames, but a null answer must not
    // depend on the edge list being empty either.
    expect(diagramThumb([], [edge({ id: 1 })], 96, 64)).toBeNull()
  })

  it('always reports the requested box as the viewBox', () => {
    const t = diagramThumb([frame({ id: 1 })], [], 96, 64)
    expect(t?.viewBox).toBe('0 0 96 64')
  })

  it('fits and centres a single frame, preserving aspect ratio', () => {
    // A 100x100 frame in a 96x64 box: height binds, so scale = 60/100.
    const t = diagramThumb([frame({ id: 1 })], [], 96, 64)!
    expect(t.rects).toHaveLength(1)
    expect(t.rects[0].w).toBeCloseTo(60)
    expect(t.rects[0].h).toBeCloseTo(60)
    // Letterboxed horizontally, flush (minus padding) vertically.
    expect(t.rects[0].x).toBeCloseTo((96 - 60) / 2)
    expect(t.rects[0].y).toBeCloseTo((64 - 60) / 2)
  })

  it('scales a wide board off its binding axis', () => {
    // Bounding box 200x50 in a 96x64 box: width binds, scale = 92/200.
    const t = diagramThumb(
      [frame({ id: 1, w: 200, h: 50 })],
      [],
      96,
      64,
    )!
    expect(t.rects[0].w).toBeCloseTo(92)
    expect(t.rects[0].h).toBeCloseTo(23)
  })

  it('does not divide by a zero-area bounding box', () => {
    // Every frame at one point with no size: nothing constrains the scale.
    const t = diagramThumb(
      [
        frame({ id: 1, x: 40, y: 40, w: 0, h: 0 }),
        frame({ id: 2, x: 40, y: 40, w: 0, h: 0 }),
      ],
      [],
      96,
      64,
    )!
    for (const r of t.rects) {
      expect(Number.isFinite(r.x)).toBe(true)
      expect(Number.isFinite(r.y)).toBe(true)
      expect(r.x).toBeCloseTo(48)
      expect(r.y).toBeCloseTo(32)
      // Scale falls back to 1 and the floor keeps the rect visible.
      expect(r.w).toBe(2)
      expect(r.h).toBe(2)
    }
  })

  it('handles a bounding box flat on one axis', () => {
    // Two zero-height frames side by side: only the x axis constrains.
    const t = diagramThumb(
      [
        frame({ id: 1, x: 0, y: 10, w: 100, h: 0 }),
        frame({ id: 2, x: 100, y: 10, w: 100, h: 0 }),
      ],
      [],
      96,
      64,
    )!
    // scale = 92/200; both rects sit on the vertical centre line.
    expect(t.rects[0].w).toBeCloseTo(46)
    expect(t.rects[0].x).toBeCloseTo(2)
    expect(t.rects[1].x).toBeCloseTo(48)
    expect(t.rects[0].y).toBeCloseTo(32)
    expect(t.rects[0].h).toBe(2)
  })

  it('letterboxes frames at negative coordinates like any other', () => {
    const negative = diagramThumb(
      [
        frame({ id: 1, x: -300, y: -200, w: 100, h: 100 }),
        frame({ id: 2, x: -100, y: -100, w: 100, h: 100 }),
      ],
      [],
      96,
      64,
    )!
    const shifted = diagramThumb(
      [
        frame({ id: 1, x: 0, y: 0, w: 100, h: 100 }),
        frame({ id: 2, x: 200, y: 100, w: 100, h: 100 }),
      ],
      [],
      96,
      64,
    )!
    // Only the bounding box's shape matters, never where it sits.
    expect(negative.rects).toEqual(shifted.rects)
    for (const r of negative.rects) {
      expect(r.x).toBeGreaterThanOrEqual(0)
      expect(r.y).toBeGreaterThanOrEqual(0)
      expect(r.x + r.w).toBeLessThanOrEqual(96)
      expect(r.y + r.h).toBeLessThanOrEqual(64)
    }
  })

  it('draws edges centre to centre', () => {
    const t = diagramThumb(
      [
        frame({ id: 1, x: 0, y: 0, w: 100, h: 100 }),
        frame({ id: 2, x: 100, y: 0, w: 100, h: 100 }),
      ],
      [edge({ id: 7, from_frame: 1, to_frame: 2 })],
      96,
      64,
    )!
    // Bounding box 200x100 in 96x64: width binds, scale = 92/200 = 0.46.
    expect(t.lines).toHaveLength(1)
    expect(t.lines[0]).toEqual({
      id: 7,
      x1: 0.46 * 50 + 2,
      y1: 0.46 * 50 + (64 - 46) / 2,
      x2: 0.46 * 150 + 2,
      y2: 0.46 * 50 + (64 - 46) / 2,
    })
  })

  it('drops an edge whose endpoint frame is missing', () => {
    const t = diagramThumb(
      [frame({ id: 1 })],
      [
        edge({ id: 1, from_frame: 1, to_frame: 99 }),
        edge({ id: 2, from_frame: 99, to_frame: 1 }),
      ],
      96,
      64,
    )!
    expect(t.lines).toEqual([])
  })

  it('carries each frame id, shape and colour through', () => {
    const t = diagramThumb(
      [
        frame({ id: 3, shape: 'decision', color: '#ff2bd6' }),
        frame({ id: 4, x: 200 }),
      ],
      [],
      96,
      64,
    )!
    expect(t.rects.map((r) => r.id)).toEqual([3, 4])
    expect(t.rects[0].shape).toBe('decision')
    expect(t.rects[0].color).toBe('#ff2bd6')
    expect(t.rects[1].shape).toBeNull()
    expect(t.rects[1].color).toBeNull()
  })
})
