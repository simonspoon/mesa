import { describe, expect, it } from 'vitest'
import { dropIntentFor, zoneForOffset, type Orderable } from './navOrder'

// Three top-level projects in rendered order, one sort_order apart — what
// `create_project`'s next-value rule produces on a fresh install.
const list: Orderable[] = [
  { id: 1, sort_order: 1 },
  { id: 2, sort_order: 2 },
  { id: 3, sort_order: 3 },
]

// One server-ordered array with nesting: two roots, two children under the
// first, and a grandchild under the first child.
//   1
//   ├ 10
//   │  └ 100
//   └ 11
//   2
const nested: Orderable[] = [
  { id: 1, sort_order: 1, parent_id: null },
  { id: 10, sort_order: 2, parent_id: 1 },
  { id: 100, sort_order: 3, parent_id: 10 },
  { id: 11, sort_order: 4, parent_id: 1 },
  { id: 2, sort_order: 5, parent_id: null },
]

describe('zoneForOffset', () => {
  it('reads the top quarter as before and the bottom quarter as after', () => {
    expect(zoneForOffset(2, 40)).toBe('before')
    expect(zoneForOffset(38, 40)).toBe('after')
  })

  it('reads the middle half as nest-into', () => {
    expect(zoneForOffset(12, 40)).toBe('into')
    expect(zoneForOffset(20, 40)).toBe('into')
    expect(zoneForOffset(28, 40)).toBe('into')
  })

  it('clamps an offset outside the row rather than rejecting it', () => {
    expect(zoneForOffset(-30, 40)).toBe('before')
    expect(zoneForOffset(80, 40)).toBe('after')
  })

  it('does not divide by a zero height', () => {
    expect(zoneForOffset(0, 0)).toBe('into')
  })
})

describe('dropIntentFor — reordering among siblings', () => {
  it('drops onto the head with next - 1', () => {
    expect(dropIntentFor(list, 3, 1, 'before')).toEqual({ parent_id: null, sort_order: 0 })
  })

  it('drops between two rows with their midpoint', () => {
    // 1 dropped after 2: without 1 the list is [2, 3], so it lands between.
    expect(dropIntentFor(list, 1, 2, 'after')).toEqual({ parent_id: null, sort_order: 2.5 })
  })

  it('drops onto the tail with prev + 1', () => {
    expect(dropIntentFor(list, 1, 3, 'after')).toEqual({ parent_id: null, sort_order: 4 })
  })

  it('keeps subdividing rather than renumbering', () => {
    // Repeated inserts into the same gap halve it each time; the neighbours
    // are never rewritten, which is what keeps one drag to one request.
    const tight: Orderable[] = [
      { id: 1, sort_order: 1 },
      { id: 2, sort_order: 1.5 },
      { id: 3, sort_order: 9 },
    ]
    expect(dropIntentFor(tight, 3, 2, 'before')).toEqual({ parent_id: null, sort_order: 1.25 })
  })

  it('reorders among siblings without touching rows at other levels', () => {
    // 11 dropped before 10: the only rows in play are 1's children [10, 11],
    // so the value is below 10's, not the parent's or the other root's.
    expect(dropIntentFor(nested, 11, 10, 'before')).toEqual({ parent_id: 1, sort_order: 1 })
  })
})

describe('dropIntentFor — reparenting', () => {
  it('nests into a childless row, seeding sort_order to 1', () => {
    expect(dropIntentFor(nested, 11, 2, 'into')).toEqual({ parent_id: 2, sort_order: 1 })
  })

  it('appends after an existing child', () => {
    // 2 into 1: 1's children are [10 @2, 11 @4], so 2 lands at 5.
    expect(dropIntentFor(nested, 2, 1, 'into')).toEqual({ parent_id: 1, sort_order: 5 })
  })

  it('un-nests a child onto the edge of a top-level row', () => {
    // 10 dropped after root 2: it becomes a top-level row past the last one.
    expect(dropIntentFor(nested, 10, 2, 'after')).toEqual({ parent_id: null, sort_order: 6 })
    // …and before root 1, which is the head of the top level.
    expect(dropIntentFor(nested, 10, 1, 'before')).toEqual({ parent_id: null, sort_order: 0 })
  })

  it('edge-drops between two rows under a different parent', () => {
    // Root 2 dropped after 10 becomes 1's child between 10 (@2) and 11 (@4).
    expect(dropIntentFor(nested, 2, 10, 'after')).toEqual({ parent_id: 1, sort_order: 3 })
    // The grandchild pulled up beside its own parent's sibling.
    expect(dropIntentFor(nested, 100, 11, 'before')).toEqual({ parent_id: 1, sort_order: 3 })
  })

  it('treats a parent_id naming no row in the array as top level', () => {
    // The sidebar renders the ACTIVE partition of one fetch, so a live child
    // of an archived parent arrives pointing at a row that is not here. It
    // draws at top level, and an edge drop onto it must mean top level too —
    // never "adopt the hidden archived parent".
    const orphan: Orderable[] = [
      { id: 1, sort_order: 1, parent_id: null },
      { id: 5, sort_order: 2, parent_id: 99 },
    ]
    expect(dropIntentFor(orphan, 1, 5, 'after')).toEqual({ parent_id: null, sort_order: 3 })
  })
})

describe('dropIntentFor — drops that write nothing', () => {
  it('returns null when the row is dropped on itself', () => {
    expect(dropIntentFor(list, 2, 2, 'into')).toBeNull()
    expect(dropIntentFor(list, 2, 2, 'before')).toBeNull()
  })

  it('returns null for a drop onto its own descendant at any depth', () => {
    // 1 into its child 10, and into its grandchild 100: `Store` would answer
    // both with a 409, so neither is offered.
    expect(dropIntentFor(nested, 1, 10, 'into')).toBeNull()
    expect(dropIntentFor(nested, 1, 100, 'into')).toBeNull()
    expect(dropIntentFor(nested, 1, 100, 'after')).toBeNull()
  })

  it('returns null when the computed position is the one it already holds', () => {
    // 1 before 2: without 1 the list is [2, 3], insert before 2 → 2 - 1 = 1,
    // which is exactly what row 1 already holds. No PATCH.
    expect(dropIntentFor(list, 1, 2, 'before')).toBeNull()
    // …and the mirror: 2 after 1 is where 2 already sits.
    expect(dropIntentFor(list, 2, 1, 'after')).toBeNull()
  })

  it('returns null when nesting where it is already the last child', () => {
    // 11 is already 1's last child; dropping into 1 appends it there again.
    expect(dropIntentFor(nested, 11, 1, 'into')).toBeNull()
    // 10 is NOT last, so the same gesture is a real move.
    expect(dropIntentFor(nested, 10, 1, 'into')).toEqual({ parent_id: 1, sort_order: 5 })
  })

  it('returns null for an unknown dragged row', () => {
    expect(dropIntentFor(list, 99, 1, 'into')).toBeNull()
  })
})

describe('dropIntentFor — no row under the pointer', () => {
  it('means the end of the top-level list', () => {
    // Whatever the zone: there is no row whose edges could have been meant.
    expect(dropIntentFor(nested, 10, -1, 'into')).toEqual({ parent_id: null, sort_order: 6 })
    expect(dropIntentFor(nested, 10, -1, 'before')).toEqual({ parent_id: null, sort_order: 6 })
  })

  it('pulls a nested row out to the end of the top level', () => {
    const one: Orderable[] = [
      { id: 1, sort_order: 5, parent_id: null },
      { id: 10, sort_order: 6, parent_id: 1 },
    ]
    expect(dropIntentFor(one, 10, -1, 'into')).toEqual({ parent_id: null, sort_order: 6 })
    // The only row there is, already at top level: nothing to write.
    expect(dropIntentFor([{ id: 1, sort_order: 7 }], 1, -1, 'into')).toBeNull()
  })

  it('returns null when it is already the last top-level row', () => {
    expect(dropIntentFor(list, 3, -1, 'after')).toBeNull()
  })
})

describe('dropIntentFor — malformed input', () => {
  it('does not hang on a parent_id cycle', () => {
    const cyclic: Orderable[] = [
      { id: 1, sort_order: 1, parent_id: 2 },
      { id: 2, sort_order: 2, parent_id: 1 },
      { id: 3, sort_order: 3, parent_id: null },
    ]
    // 3 is nobody's descendant, so this resolves; the point is that the
    // descendant walk terminates.
    expect(dropIntentFor(cyclic, 3, 1, 'into')).toEqual({ parent_id: 1, sort_order: 3 })
    // …and 1 onto 2 is a cycle, caught rather than looped over.
    expect(dropIntentFor(cyclic, 1, 2, 'into')).toBeNull()
  })
})
