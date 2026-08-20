/**
 * How much room a frame's *silhouette* takes beyond the card it wraps
 * (mesa task 892).
 *
 * Every non-rectangular shape on the diagram canvas is drawn as an oversized
 * `::before` backdrop behind an unclipped card (the rule `.frame-decision`
 * established and `App.css` records: a silhouette that would eat the header is
 * never a `clip-path` on the card itself). That backdrop is what the eye reads
 * as the node — but nothing else in the canvas knew it existed:
 *
 * - **auto-layout** packed frames by their stored `w`/`h`, so a diamond
 *   1.7× as tall as its card overlapped both neighbouring layers;
 * - **connectors** anchored to the card's measured box, so an edge stopped
 *   well *inside* the diamond instead of touching its point.
 *
 * This module is the one place the two worlds meet: `SHAPE_BLEED` mirrors the
 * `inset` each shape's backdrop is drawn with in `App.css`, and `outerBox()`
 * turns a card box into the box the shape actually occupies. Change an
 * `inset` there and the matching entry here, or the canvas silently drifts
 * back to the overlap it had.
 *
 * A bleed is per-side and in *px*, but may be expressed as a fraction of the
 * card's own width/height (the diamond and the ellipse are, because their
 * geometry is proportional); the px shapes are the ones whose silhouette is a
 * fixed detail — a 28px slant, a 28px wave, a 22px cylinder cap.
 */

import type { FrameShape } from './types/FrameShape'

export type Bleed = {
  top: number
  right: number
  bottom: number
  left: number
}

export type BoxRect = { x: number; y: number; w: number; h: number }

const NONE: Bleed = { top: 0, right: 0, bottom: 0, left: 0 }

/** A bleed given in px, identical whatever the card measures. */
const px = (top: number, right: number, bottom: number, left: number) => ({
  kind: 'px' as const,
  top,
  right,
  bottom,
  left,
})

/** A bleed given as a fraction of the card's own width (left/right) and
 *  height (top/bottom) — the proportional silhouettes. */
const frac = (vertical: number, horizontal: number) => ({
  kind: 'frac' as const,
  top: vertical,
  right: horizontal,
  bottom: vertical,
  left: horizontal,
})

type BleedSpec = ReturnType<typeof px> | ReturnType<typeof frac>

/**
 * Per-shape backdrop inflation, mirroring `App.css` one-for-one. Shapes absent
 * from this table draw entirely inside their own card box (a rectangle, a
 * rounded rectangle, a double border, an inset band) and so bleed nothing.
 */
const SHAPE_BLEED: Partial<Record<FrameShape, BleedSpec>> = {
  // `.frame-decision::before` / `.frame-relationship::before`: inset -35% -20%
  decision: frac(0.35, 0.2),
  relationship: frac(0.35, 0.2),
  // `.frame-attribute::before`: inset -24%
  attribute: frac(0.24, 0.24),
  // `.frame-data::before`: inset -6px -28px
  data: px(6, 28, 6, 28),
  // `.frame-document::before`: inset -6px -6px -28px -6px
  document: px(6, 6, 28, 6),
  // `.frame-database::before`: inset -22px -10px
  database: px(22, 10, 22, 10),
  // `.frame-note::before`: inset -8px -26px -8px -8px
  note: px(8, 26, 8, 8),
}

/** The room `shape`'s silhouette takes outside a `w`×`h` card, per side, in
 *  px. A generic card (`null`) and every rectangle-ish shape bleed nothing. */
export function shapeBleed(
  shape: FrameShape | null | undefined,
  w: number,
  h: number,
): Bleed {
  const spec = shape ? SHAPE_BLEED[shape] : undefined
  if (!spec) return NONE
  if (spec.kind === 'px') {
    return {
      top: spec.top,
      right: spec.right,
      bottom: spec.bottom,
      left: spec.left,
    }
  }
  return {
    top: spec.top * h,
    right: spec.right * w,
    bottom: spec.bottom * h,
    left: spec.left * w,
  }
}

/** The same bleed as a set of CSS lengths, for the one consumer that needs it
 *  in CSS rather than in px: the connection handles, which React Flow pins to
 *  the node wrapper's own edge and which therefore have to be pushed out to the
 *  silhouette by an offset the browser resolves against the card. A
 *  proportional bleed stays a percentage — `top`/`bottom` resolve against the
 *  card's height and `left`/`right` against its width, exactly the axes
 *  `frac()` is defined on — and a fixed one stays px. `null` for a shape that
 *  bleeds nothing, so the caller can leave React Flow's own positioning alone
 *  rather than restating it. */
export function shapeBleedCss(
  shape: FrameShape | null | undefined,
): Record<keyof Bleed, string> | null {
  const spec = shape ? SHAPE_BLEED[shape] : undefined
  if (!spec) return null
  const length = (n: number) =>
    spec.kind === 'px' ? `${n}px` : `${n * 100}%`
  return {
    top: length(spec.top),
    right: length(spec.right),
    bottom: length(spec.bottom),
    left: length(spec.left),
  }
}

/** The box a frame's *silhouette* occupies, given the box its card occupies —
 *  what auto-layout must not overlap and what a connector must touch. */
export function outerBox(box: BoxRect, shape: FrameShape | null | undefined): BoxRect {
  const b = shapeBleed(shape, box.w, box.h)
  return {
    x: box.x - b.left,
    y: box.y - b.top,
    w: box.w + b.left + b.right,
    h: box.h + b.top + b.bottom,
  }
}
