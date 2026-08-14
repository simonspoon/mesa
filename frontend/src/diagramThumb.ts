/**
 * Mini-map geometry for a diagram's list row (mesa task 854).
 *
 * The Diagrams index shows each board's *current saved state* as a thumbnail:
 * its frames as small rounded rects, its edges as straight lines between frame
 * centres. That is a pure coordinate problem — fit an arbitrary canvas
 * bounding box into a fixed w×h box, letterboxed and centred, aspect ratio
 * preserved — so it lives here rather than inline in `DiagramListView.tsx`.
 *
 * The canvas's own renderer is deliberately NOT reused: a thumbnail is a
 * silhouette, not a small copy of the board (no shape clip-paths, no routed
 * connectors, no waypoints), and at 96px wide none of that would read anyway.
 */

import type { Frame } from './types/Frame'
import type { FrameEdge } from './types/FrameEdge'
import type { FrameShape } from './types/FrameShape'

/** One frame, already scaled into the thumbnail's own pixel space. */
export interface ThumbRect {
  id: number
  x: number
  y: number
  w: number
  h: number
  /** Carried through so the mini-map can hint the shape; the renderer decides
   *  how (a rounder corner, a tint), it is never a silhouette. */
  shape: FrameShape | null
  /** The frame's free-text colour hint, verbatim — `null` means "use the
   *  default stroke". */
  color: string | null
}

/** One edge, centre-to-centre, in the thumbnail's own pixel space. */
export interface ThumbLine {
  id: number
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface DiagramThumb {
  /** `<svg viewBox>`, always anchored at the origin of the requested box. */
  viewBox: string
  rects: ThumbRect[]
  lines: ThumbLine[]
}

/** Inset so a rect drawn at the bounding box's edge keeps its stroke. */
const PAD = 2

/** Smallest a scaled frame may draw at — below ~2px a rect is invisible. */
const MIN_SIDE = 2

/**
 * Fits `frames`/`edges` into a `width`×`height` thumbnail.
 *
 * Returns `null` for a board with no frames — there is no bounding box to fit,
 * and an empty `<svg>` reads as a broken image, so the caller renders a
 * placeholder instead. Every other degenerate board is geometry, not an error:
 * a single frame, frames all stacked at one point (zero-area bounding box —
 * nothing divides by it), and negative coordinates all letterbox normally.
 *
 * Edges naming a frame that isn't in `frames` are dropped rather than drawn to
 * a guessed point; the list fetches both halves of one view, so that only
 * happens if a frame is deleted between the two.
 */
export function diagramThumb(
  frames: Frame[],
  edges: FrameEdge[],
  width: number,
  height: number,
): DiagramThumb | null {
  if (frames.length === 0) return null

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const f of frames) {
    minX = Math.min(minX, f.x)
    minY = Math.min(minY, f.y)
    maxX = Math.max(maxX, f.x + f.w)
    maxY = Math.max(maxY, f.y + f.h)
  }
  const boxW = maxX - minX
  const boxH = maxY - minY

  // Letterbox: one scale for both axes, taken from whichever axis binds. An
  // axis of zero extent constrains nothing (Infinity), and a board that is a
  // single point constrains neither — scale 1 then, so the fallback is
  // "draw it life-size, centred" rather than a division by zero.
  const innerW = Math.max(width - PAD * 2, 0)
  const innerH = Math.max(height - PAD * 2, 0)
  const sx = boxW > 0 ? innerW / boxW : Infinity
  const sy = boxH > 0 ? innerH / boxH : Infinity
  const fit = Math.min(sx, sy)
  const scale = Number.isFinite(fit) ? fit : 1

  // Centre the scaled box inside the requested one.
  const offX = (width - boxW * scale) / 2 - minX * scale
  const offY = (height - boxH * scale) / 2 - minY * scale
  const px = (x: number) => x * scale + offX
  const py = (y: number) => y * scale + offY

  const rects: ThumbRect[] = frames.map((f) => ({
    id: f.id,
    x: px(f.x),
    y: py(f.y),
    w: Math.max(f.w * scale, MIN_SIDE),
    h: Math.max(f.h * scale, MIN_SIDE),
    shape: f.shape,
    color: f.color,
  }))

  const centres = new Map(
    frames.map((f) => [f.id, [px(f.x + f.w / 2), py(f.y + f.h / 2)] as const]),
  )
  const lines: ThumbLine[] = []
  for (const e of edges) {
    const from = centres.get(e.from_frame)
    const to = centres.get(e.to_frame)
    if (!from || !to) continue
    lines.push({ id: e.id, x1: from[0], y1: from[1], x2: to[0], y2: to[1] })
  }

  return { viewBox: `0 0 ${width} ${height}`, rects, lines }
}
