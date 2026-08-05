import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_RATIO, MAX_RATIO, MIN_RATIO, emptyTabsState, type TabsState } from './fileTabs'
import { loadOpenFiles, saveOpenFiles } from './openFiles'

const KEY = 'mesa-open-files'

beforeEach(() => localStorage.clear())

/** Write a raw (possibly corrupt) entry the way a hand-edit or an older shape
 *  would leave it. */
function seed(entries: Record<string, unknown>) {
  localStorage.setItem(KEY, JSON.stringify(entries))
}

const split: TabsState = {
  left: { tabs: ['a.ts', 'b.ts'], active: 'b.ts' },
  right: { tabs: ['c.ts'], active: 'c.ts' },
  focused: 'right',
  ratio: 0.4,
}

describe('loadOpenFiles', () => {
  it('is empty for an absent key, malformed JSON and a non-object', () => {
    expect(loadOpenFiles(1, false)).toEqual(emptyTabsState())
    localStorage.setItem(KEY, '{not json')
    expect(loadOpenFiles(1, false)).toEqual(emptyTabsState())
    localStorage.setItem(KEY, '["a"]')
    expect(loadOpenFiles(1, false)).toEqual(emptyTabsState())
    localStorage.setItem(KEY, 'null')
    expect(loadOpenFiles(1, false)).toEqual(emptyTabsState())
  })

  it('is empty for garbage entry shapes', () => {
    seed({ 1: 'nope', 2: 42, 3: null, 4: [], 5: {} })
    for (const id of [1, 2, 3, 4, 5]) {
      expect(loadOpenFiles(id, false)).toEqual(emptyTabsState())
    }
  })

  it('round-trips a saved state', () => {
    saveOpenFiles(7, split)
    expect(loadOpenFiles(7, false)).toEqual(split)
  })

  it('repairs an active that is not in its pane', () => {
    seed({ 7: { left: { tabs: ['a.ts', 'b.ts'], active: 'gone.ts' }, right: null, focused: 'left', ratio: 0.5 } })
    expect(loadOpenFiles(7, false).left).toEqual({ tabs: ['a.ts', 'b.ts'], active: 'a.ts' })
  })

  it('nulls the active of an empty pane, and drops an empty right pane', () => {
    seed({ 7: { left: { tabs: [], active: 'a.ts' }, right: { tabs: [], active: 'c.ts' }, focused: 'right', ratio: 0.5 } })
    expect(loadOpenFiles(7, false)).toEqual(emptyTabsState())
  })

  it('promotes the right pane when only the left is empty', () => {
    seed({ 7: { left: { tabs: [], active: null }, right: { tabs: ['c.ts'], active: 'c.ts' }, focused: 'right', ratio: 0.5 } })
    const s = loadOpenFiles(7, false)
    expect(s.left).toEqual({ tabs: ['c.ts'], active: 'c.ts' })
    expect(s.right).toBeNull()
    expect(s.focused).toBe('left')
  })

  it('dedupes a pane and drops non-string tabs', () => {
    seed({ 7: { left: { tabs: ['a.ts', 'a.ts', 3, null, '', 'b.ts'], active: 'b.ts' }, right: null, focused: 'left', ratio: 0.5 } })
    expect(loadOpenFiles(7, false).left).toEqual({ tabs: ['a.ts', 'b.ts'], active: 'b.ts' })
  })

  it('clamps an out-of-range or non-numeric ratio', () => {
    seed({ 1: { ...split, ratio: 5 }, 2: { ...split, ratio: -1 }, 3: { ...split, ratio: 'wide' } })
    expect(loadOpenFiles(1, false).ratio).toBe(MAX_RATIO)
    expect(loadOpenFiles(2, false).ratio).toBe(MIN_RATIO)
    expect(loadOpenFiles(3, false).ratio).toBe(DEFAULT_RATIO)
  })

  it('never reports right focus without a right pane', () => {
    seed({ 7: { left: { tabs: ['a.ts'], active: 'a.ts' }, right: null, focused: 'right', ratio: 0.5 } })
    expect(loadOpenFiles(7, false).focused).toBe('left')
  })

  it('folds a stored split on the narrow tier, keeping the focused pane', () => {
    saveOpenFiles(7, split)
    const s = loadOpenFiles(7, true)
    expect(s.right).toBeNull()
    expect(s.left).toEqual({ tabs: ['c.ts'], active: 'c.ts' })
    expect(s.focused).toBe('left')
  })

  it('keeps projects isolated', () => {
    saveOpenFiles(1, split)
    expect(loadOpenFiles(2, false)).toEqual(emptyTabsState())
    saveOpenFiles(2, { ...emptyTabsState(), left: { tabs: ['z.ts'], active: 'z.ts' } })
    expect(loadOpenFiles(1, false)).toEqual(split)
    expect(loadOpenFiles(2, false).left.tabs).toEqual(['z.ts'])
  })
})

describe('saveOpenFiles', () => {
  it('removes the entry for an empty state instead of storing one', () => {
    saveOpenFiles(1, split)
    saveOpenFiles(2, split)
    saveOpenFiles(1, emptyTabsState())
    expect(Object.keys(JSON.parse(localStorage.getItem(KEY)!))).toEqual(['2'])
  })

  it('writes nothing at all when an empty state has no entry to remove', () => {
    saveOpenFiles(1, emptyTabsState())
    expect(localStorage.getItem(KEY)).toBeNull()
  })
})
