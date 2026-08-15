/**
 * The diagram canvas's left-hand shape palette (mesa task 868).
 *
 * The palette is the toolbar down the left of the diagram space: one row per
 * shape this board's `diagram_type` accepts, each row showing the shape's
 * silhouette *and* its name, and each row draggable onto the canvas to create
 * that frame where it is dropped (a click still creates one, which is what the
 * old wrapped button cluster did).
 *
 * What lives here is the part that is decidable without a rendered tree: which
 * rows a board offers, the drag payload's encoding, and where the dropped
 * frame lands. The silhouettes themselves are markup and stay in
 * `DiagramCanvas.tsx` beside the node components they mirror.
 *
 * The decode is deliberately strict. A drop carries a string from *somewhere*
 * — another app, a file, a palette row dragged from a board of a different
 * type in another tab — and offering the canvas a shape the server rejects
 * turns a drop into a 422 the user cannot act on. So a payload is only
 * honoured when it names a shape `SHAPES_FOR_TYPE` lists for *this* board;
 * anything else is not a shape drop at all.
 */

import { SHAPE_LABELS, SHAPES_FOR_TYPE } from './diagramOptions'
import type { DiagramType } from './types/DiagramType'
import type { FrameShape } from './types/FrameShape'

/** The palette's own drag type. A private mime rather than `text/plain` so a
 *  drag from anywhere else on the page (or from another app) is distinguishable
 *  from a palette row at `dragover` time, before the drop. */
export const SHAPE_DRAG_MIME = 'application/x-mesa-frame-shape'

/** Payload token for the generic (`shape: null`) card — a storyboard board's
 *  plain frame, which has no `FrameShape` string to carry. */
export const GENERIC_TOKEN = 'generic'

/** The frame size `POST /api/diagrams/{id}/frames` defaults to when the body
 *  names no `w`/`h` (`src/api.rs`). Used only to centre a dropped frame under
 *  the cursor; the create still sends no size, so the server stays the one
 *  place the default is defined. */
export const DEFAULT_FRAME_W = 240
export const DEFAULT_FRAME_H = 140

/** One palette row. `shape` is what `createFrame` is given (`null` = generic). */
export interface PaletteItem {
  /** Stable React key — the shape token, or `GENERIC_TOKEN`. */
  key: string
  shape: FrameShape | null
  /** The name shown beside the silhouette. */
  label: string
}

/** The rows this board type offers, in `SHAPES_FOR_TYPE` order (so the first
 *  row is still the board's default shape, matching the quick-create
 *  gestures). */
export function paletteItems(type: DiagramType): PaletteItem[] {
  return SHAPES_FOR_TYPE[type].map((shape) => ({
    key: shape ?? GENERIC_TOKEN,
    shape,
    label: shape === null ? 'frame' : SHAPE_LABELS[shape],
  }))
}

/** The `dataTransfer` payload for a palette row. */
export function encodeShapeDrag(shape: FrameShape | null): string {
  return shape ?? GENERIC_TOKEN
}

/**
 * Reads a dropped payload back, or `null` when it is not a palette drop this
 * board can honour (foreign data, an empty payload, a shape another board type
 * offers). The success value is wrapped so that `{ shape: null }` — the
 * legitimate generic card — is distinguishable from "not a shape drop".
 */
export function decodeShapeDrag(
  raw: string | null | undefined,
  type: DiagramType,
): { shape: FrameShape | null } | null {
  if (raw == null) return null
  const token = raw.trim()
  if (token === '') return null
  const shape = token === GENERIC_TOKEN ? null : (token as FrameShape)
  if (!SHAPES_FOR_TYPE[type].includes(shape)) return null
  return { shape }
}

/**
 * Top-left corner for a frame dropped at `point` (already converted to flow
 * coordinates by the caller), so the new frame is centred under the cursor
 * rather than hanging down-right of it — the drop point is where the user
 * pointed at the *shape*, not at its corner.
 *
 * Rounded, like every other position mesa writes.
 */
export function dropPosition(point: { x: number; y: number }): {
  x: number
  y: number
} {
  return {
    x: Math.round(point.x - DEFAULT_FRAME_W / 2),
    y: Math.round(point.y - DEFAULT_FRAME_H / 2),
  }
}
