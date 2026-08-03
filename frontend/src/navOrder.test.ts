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
})
