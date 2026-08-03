import { beforeEach, describe, expect, it } from 'vitest'
import {
  expandAncestors,
  loadCollapsed,
  saveCollapsed,
  toggleCollapsed,
} from './navCollapse'

const KEY = 'mesa-nav-collapsed'

beforeEach(() => {
  localStorage.clear()
})

describe('loadCollapsed / saveCollapsed', () => {
  it('round-trips a set through localStorage', () => {
    saveCollapsed(new Set([3, 7]))
    expect(loadCollapsed()).toEqual(new Set([3, 7]))
  })

  it('is empty on a first visit', () => {
    expect(loadCollapsed()).toEqual(new Set())
  })

  it('reads a malformed entry as nothing collapsed', () => {
    // Every shape a hand-edited or stale key could take; none may throw.
    for (const raw of ['not json', '{"a":1}', '"7"', 'null']) {
      localStorage.setItem(KEY, raw)
      expect(loadCollapsed()).toEqual(new Set())
    }
  })

  it('drops non-numeric members rather than the whole set', () => {
    localStorage.setItem(KEY, '[1,"2",null,3]')
    expect(loadCollapsed()).toEqual(new Set([1, 3]))
  })
})

describe('toggleCollapsed', () => {
  it('collapses then expands the same id', () => {
    const collapsed = toggleCollapsed(new Set(), 5)
    expect(collapsed).toEqual(new Set([5]))
    expect(toggleCollapsed(collapsed, 5)).toEqual(new Set())
  })

  it('returns a new set, never a mutation', () => {
    const before = new Set([1])
    const after = toggleCollapsed(before, 2)
    expect(before).toEqual(new Set([1]))
    expect(after).not.toBe(before)
  })
})

describe('expandAncestors', () => {
  it('expands every collapsed ancestor so the active row is visible', () => {
    expect(expandAncestors(new Set([1, 10, 99]), [10, 1])).toEqual(new Set([99]))
  })

  it('returns the same set when nothing was collapsed, so no state write', () => {
    const ids = new Set([99])
    expect(expandAncestors(ids, [10, 1])).toBe(ids)
    expect(expandAncestors(ids, [])).toBe(ids)
  })
})
