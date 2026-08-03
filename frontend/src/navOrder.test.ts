import { describe, expect, it } from 'vitest'
import { sortOrderForDrop, type Orderable } from './navOrder'

// Three projects in rendered order, one sort_order apart — what
// `create_project`'s next-value rule produces on a fresh install.
const list: Orderable[] = [
  { id: 1, sort_order: 1 },
  { id: 2, sort_order: 2 },
  { id: 3, sort_order: 3 },
]

describe('sortOrderForDrop', () => {
  it('drops onto the head with next - 1', () => {
    expect(sortOrderForDrop(list, 3, 1)).toBe(0)
  })

  it('drops between two rows with their midpoint', () => {
    // 1 dragged onto 3: without 1 the list is [2, 3], so it lands before 3.
    expect(sortOrderForDrop(list, 1, 3)).toBe(2.5)
  })

  it('drops onto the tail with prev + 1', () => {
    // No row to hover past the last one, so `over` is the list itself.
    expect(sortOrderForDrop(list, 1, -1)).toBe(4)
  })

  it('returns null when the row is dropped on itself', () => {
    expect(sortOrderForDrop(list, 2, 2)).toBeNull()
  })

  it('returns null when the computed position is where the row already is', () => {
    // 1 onto 2: without 1 the list is [2, 3], insert before 2 → 2 - 1 = 1,
    // which is exactly what row 1 already holds. No PATCH.
    expect(sortOrderForDrop(list, 1, 2)).toBeNull()
  })

  it('returns null for an unknown dragged row', () => {
    expect(sortOrderForDrop(list, 99, 1)).toBeNull()
  })

  it('keeps subdividing rather than renumbering', () => {
    // Repeated inserts into the same gap halve it each time; the neighbours
    // are never rewritten, which is what keeps one drag to one request.
    const tight: Orderable[] = [
      { id: 1, sort_order: 1 },
      { id: 2, sort_order: 1.5 },
      { id: 3, sort_order: 9 },
    ]
    expect(sortOrderForDrop(tight, 3, 2)).toBe(1.25)
  })

  it('assigns 1 when the list has nothing else in it', () => {
    expect(sortOrderForDrop([{ id: 1, sort_order: 7 }], 1, -1)).toBe(1)
  })

  // Task 668: the list is a tree now, and a drag may only reorder a row among
  // its own siblings. `nested` is one server-ordered array: two roots, two
  // children under the first.
  const nested: Orderable[] = [
    { id: 1, sort_order: 1, parent_id: null },
    { id: 10, sort_order: 2, parent_id: 1 },
    { id: 11, sort_order: 3, parent_id: 1 },
    { id: 2, sort_order: 4, parent_id: null },
  ]

  it('reorders among siblings, ignoring rows at other levels', () => {
    // 11 dropped on 10: the only rows in play are 1's children [10, 11], so
    // the midpoint is below 10's, not the parent's or the other root's.
    expect(sortOrderForDrop(nested, 11, 10)).toBe(1)
  })

  it('returns null when the drop lands under a different parent', () => {
    // A child dropped on a root, and a root dropped on someone's child:
    // reparenting is explicit, never a drag — so neither issues a request.
    expect(sortOrderForDrop(nested, 10, 2)).toBeNull()
    expect(sortOrderForDrop(nested, 2, 10)).toBeNull()
  })

  it('still treats a drop on no row at all as the end of the sibling list', () => {
    // The list's own droppable names no parent to disagree with, so the old
    // "append to my level" behaviour is unchanged.
    expect(sortOrderForDrop(nested, 10, -1)).toBe(4)
  })
})
