import type { DiagramType } from './types/DiagramType'
import type { EdgeMarker } from './types/EdgeMarker'
import type { EdgeStyle } from './types/EdgeStyle'
import type { FrameShape } from './types/FrameShape'

/**
 * What the diagram canvas is allowed to offer for a given board type (mesa
 * task 854) — the frontend mirror of the one server-side source of truth,
 * `DiagramType::shapes()` / `allows_generic_frame()` / `edge_markers()` in
 * `src/core/types.rs`, which `Store::validate_frame_shape` and
 * `Store::validate_edge_markers` read.
 *
 * These tables must stay in lockstep with those: offering a value the server
 * rejects turns an ordinary click into a 422 the user cannot act on. They live
 * here rather than inline in `DiagramCanvas.tsx` precisely so a test can assert
 * the whole matrix (`diagramOptions.test.ts`) — per CLAUDE.md, the pure logic a
 * component imports is what this project unit-tests, not the rendered tree.
 */

/**
 * The `Frame.shape` set each `Diagram.diagram_type` accepts, in offer order.
 *
 * `null` is the **generic card** (`shape: null`) — the pre-feature frame, and
 * per `DiagramType::allows_generic_frame` legal only on a `storyboard` board.
 * The array is therefore `(FrameShape | null)[]` and not `FrameShape[]`: the
 * first entry doubles as `defaultShape` for the canvas's quick-create gestures
 * (pane double-click, drag-to-empty-canvas, Cmd+D), so `storyboard` has to be
 * able to *say* "the shape-less card" as its default rather than express it by
 * being empty — which is how it was said before task 854 widened storyboard to
 * also offer `scene` and `note`.
 *
 * Order is offer order and the first entry is load-bearing: `brainstorm` lists
 * `idea` before `central` so a quick-create mints a branch idea, not a second
 * hub, and `storyboard` lists `null` first so its quick-create gestures still
 * make exactly the plain card they always did.
 */
export const SHAPES_FOR_TYPE: Record<DiagramType, (FrameShape | null)[]> = {
  storyboard: [null, 'scene', 'note'],
  flowchart: [
    'process',
    'decision',
    'start_end',
    'data',
    'document',
    'database',
    'predefined_process',
  ],
  erd: ['entity', 'weak_entity', 'relationship', 'attribute'],
  brainstorm: ['idea', 'central', 'note'],
}

/** Display label for each shape's add-frame button. */
export const SHAPE_LABELS: Record<FrameShape, string> = {
  process: 'process',
  decision: 'decision',
  start_end: 'start/end',
  entity: 'entity',
  central: 'central topic',
  idea: 'idea',
  scene: 'scene',
  note: 'note',
  data: 'data',
  document: 'document',
  database: 'database',
  predefined_process: 'predefined',
  weak_entity: 'weak entity',
  relationship: 'relationship',
  attribute: 'attribute',
}

/** Line styles, offered on every board type — `null` (the stored default) is
 *  a solid line, which is what an edge predating task 854 already draws. */
export const EDGE_STYLES: readonly EdgeStyle[] = ['solid', 'dashed', 'dotted']

/** The general marker family: valid on every board type. */
const GENERAL_MARKERS: readonly EdgeMarker[] = [
  'none',
  'arrow',
  'hollow_arrow',
  'circle',
  'diamond',
]

/** The ERD cardinality family: a crow's foot states a relation's multiplicity,
 *  which says nothing on a flowchart — so the server accepts these only on an
 *  `erd` board and the picker must not offer them elsewhere. */
const CARDINALITY_MARKERS: readonly EdgeMarker[] = [
  'crows_foot',
  'one',
  'zero_or_one',
  'one_or_many',
  'zero_or_many',
]

/** The endpoint markers a board of this type accepts, mirroring
 *  `DiagramType::edge_markers`. */
export function markersForType(type: DiagramType): readonly EdgeMarker[] {
  return type === 'erd'
    ? [...GENERAL_MARKERS, ...CARDINALITY_MARKERS]
    : GENERAL_MARKERS
}

/** Display label for each marker in the endpoint pickers. */
export const MARKER_LABELS: Record<EdgeMarker, string> = {
  none: 'none',
  arrow: 'arrow',
  hollow_arrow: 'hollow arrow',
  circle: 'circle',
  diamond: 'diamond',
  crows_foot: 'crow’s foot (many)',
  one: 'one',
  zero_or_one: 'zero or one',
  one_or_many: 'one or many',
  zero_or_many: 'zero or many',
}

/**
 * SVG `stroke-dasharray` for a connector's line style. `null` — the stored
 * default — and `solid` both answer `undefined`, i.e. no `stroke-dasharray`
 * property at all, so an edge that predates task 854 renders byte-identical to
 * before it.
 */
export function dashArrayFor(style: EdgeStyle | null): string | undefined {
  switch (style) {
    case 'dashed':
      return '8 5'
    case 'dotted':
      return '2 4'
    default:
      return undefined
  }
}

/** The `<marker>` element id this canvas defines for `marker`, or `null` for
 *  the markers that draw nothing: `EdgeMarker::None` says "explicitly bare",
 *  and `null` (the stored default) is handled by the caller — at the `to` end
 *  it keeps React Flow's own closed arrowhead, unchanged from today. */
export function markerId(marker: EdgeMarker): string | null {
  return marker === 'none' ? null : `mesa-edge-marker-${marker}`
}

/** `marker-start`/`marker-end` attribute value for `marker`, or `undefined`
 *  when that end draws nothing. */
export function markerUrl(marker: EdgeMarker): string | undefined {
  const id = markerId(marker)
  return id === null ? undefined : `url(#${id})`
}
