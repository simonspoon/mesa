import { describe, expect, it } from 'vitest'
import {
  EDGE_STYLES,
  MARKER_LABELS,
  SHAPES_FOR_TYPE,
  SHAPE_LABELS,
  dashArrayFor,
  markerId,
  markerUrl,
  markersForType,
  shapeLabel,
} from './diagramOptions'
import type { EdgeMarker } from './types/EdgeMarker'
import type { FrameShape } from './types/FrameShape'

// The expected values below are the server matrix, transcribed from
// `DiagramType::shapes`/`allows_generic_frame`/`edge_markers` in
// src/core/types.rs. Offering a value the server rejects is a 422 on an
// ordinary click, so this file is the lockstep check.

describe('SHAPES_FOR_TYPE', () => {
  it('matches the server shape matrix per board type, in offer order', () => {
    expect(SHAPES_FOR_TYPE.storyboard).toEqual([null, 'scene', 'note'])
    expect(SHAPES_FOR_TYPE.flowchart).toEqual([
      'process',
      'decision',
      'start_end',
      'data',
      'document',
      'database',
      'predefined_process',
    ])
    expect(SHAPES_FOR_TYPE.erd).toEqual([
      'entity',
      'weak_entity',
      'relationship',
      'attribute',
    ])
    expect(SHAPES_FOR_TYPE.brainstorm).toEqual(['idea', 'central', 'note'])
  })

  it('offers the generic card only on a storyboard board', () => {
    for (const [type, shapes] of Object.entries(SHAPES_FOR_TYPE)) {
      expect(shapes.includes(null)).toBe(type === 'storyboard')
    }
  })

  it('keeps the load-bearing first entry — the quick-create default', () => {
    // storyboard's default stays the shape-less card (pre-854 behavior);
    // brainstorm's stays a branch idea rather than a second hub.
    expect(SHAPES_FOR_TYPE.storyboard[0]).toBeNull()
    expect(SHAPES_FOR_TYPE.brainstorm[0]).toBe('idea')
  })

  it('labels every shape it offers', () => {
    for (const shapes of Object.values(SHAPES_FOR_TYPE)) {
      for (const shape of shapes) {
        if (shape !== null) expect(SHAPE_LABELS[shape]).toBeTruthy()
      }
    }
  })
})

describe('shapeLabel', () => {
  it('keeps the generic card the recognizable "add frame" button', () => {
    expect(shapeLabel(null)).toBe('add frame')
  })

  it('prefixes a named shape', () => {
    expect(shapeLabel('process')).toBe('+ process')
    expect(shapeLabel('predefined_process')).toBe('+ predefined')
  })
})

describe('markersForType', () => {
  it('offers the general family on every non-erd board', () => {
    for (const type of ['storyboard', 'flowchart', 'brainstorm'] as const) {
      expect(markersForType(type)).toEqual([
        'none',
        'arrow',
        'hollow_arrow',
        'circle',
        'diamond',
      ])
    }
  })

  it('adds the cardinality family on an erd board only', () => {
    expect(markersForType('erd')).toEqual([
      'none',
      'arrow',
      'hollow_arrow',
      'circle',
      'diamond',
      'crows_foot',
      'one',
      'zero_or_one',
      'one_or_many',
      'zero_or_many',
    ])
  })

  it('labels every marker it offers', () => {
    for (const marker of markersForType('erd')) {
      expect(MARKER_LABELS[marker as EdgeMarker]).toBeTruthy()
    }
  })
})

describe('EDGE_STYLES', () => {
  it('offers exactly the three server styles', () => {
    expect(EDGE_STYLES).toEqual(['solid', 'dashed', 'dotted'])
  })
})

describe('dashArrayFor', () => {
  it('leaves the default and an explicit solid line undecorated', () => {
    // Byte-identical to pre-854 rendering: no stroke-dasharray at all.
    expect(dashArrayFor(null)).toBeUndefined()
    expect(dashArrayFor('solid')).toBeUndefined()
  })

  it('dashes and dots differently', () => {
    expect(dashArrayFor('dashed')).toBe('8 5')
    expect(dashArrayFor('dotted')).toBe('2 4')
    expect(dashArrayFor('dashed')).not.toBe(dashArrayFor('dotted'))
  })
})

describe('markerId', () => {
  it('draws nothing for an explicit `none`', () => {
    expect(markerId('none')).toBeNull()
    expect(markerUrl('none')).toBeUndefined()
  })

  it('names one distinct marker per drawn value', () => {
    const drawn = markersForType('erd').filter((m) => m !== 'none')
    const ids = drawn.map((m) => markerId(m))
    expect(ids.every((id) => id !== null)).toBe(true)
    expect(new Set(ids).size).toBe(drawn.length)
    expect(markerUrl('crows_foot')).toBe('url(#mesa-edge-marker-crows_foot)')
  })
})

describe('SHAPE_LABELS', () => {
  it('covers every FrameShape the server can return', () => {
    const all: FrameShape[] = [
      'process',
      'decision',
      'start_end',
      'entity',
      'central',
      'idea',
      'scene',
      'note',
      'data',
      'document',
      'database',
      'predefined_process',
      'weak_entity',
      'relationship',
      'attribute',
    ]
    expect(Object.keys(SHAPE_LABELS).sort()).toEqual([...all].sort())
  })
})
