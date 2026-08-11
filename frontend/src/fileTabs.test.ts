import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RATIO,
  MAX_RATIO,
  MIN_RATIO,
  activateTab,
  clampRatio,
  closeTab,
  collapseSplit,
  cycleTab,
  dropIndex,
  emptyTabsState,
  focusPane,
  moveTab,
  openFile,
  openPaths,
  setRatio,
  splitPane,
  splitWithTab,
  type TabRect,
  type TabsState,
} from './fileTabs'

/** Three files open in one pane, the last one active — what three tree
 *  clicks leave behind. */
function three(): TabsState {
  return ['a.rs', 'b.ts', 'c.md'].reduce(openFile, emptyTabsState())
}

/** `three()` split, so both panes hold something. */
function split(): TabsState {
  return splitPane(three())!
}

/** Every invariant `TabsState` documents, asserted on a result rather than
 *  assumed — the transitions below all rebuild the object by hand. */
function assertWellFormed(state: TabsState) {
  if (state.right === null) expect(state.focused).toBe('left')
  for (const pane of [state.left, state.right]) {
    if (pane === null) continue
    expect(new Set(pane.tabs).size).toBe(pane.tabs.length)
    if (pane.tabs.length === 0) expect(pane.active).toBeNull()
    else expect(pane.tabs).toContain(pane.active)
  }
}

describe('openFile', () => {
  it('appends and activates, in click order', () => {
    const s = three()
    expect(s.left.tabs).toEqual(['a.rs', 'b.ts', 'c.md'])
    expect(s.left.active).toBe('c.md')
    expect(s.right).toBeNull()
    assertWellFormed(s)
  })

  it('re-opening an open file activates it without adding a tab', () => {
    const s = openFile(three(), 'a.rs')
    expect(s.left.tabs).toEqual(['a.rs', 'b.ts', 'c.md'])
    expect(s.left.active).toBe('a.rs')
    assertWellFormed(s)
  })

  it('opens into whichever pane has focus', () => {
    const s = openFile(split(), 'd.py')
    expect(s.focused).toBe('right')
    expect(s.right!.tabs).toEqual(['c.md', 'd.py'])
    expect(s.left.tabs).toEqual(['a.rs', 'b.ts', 'c.md'])
    assertWellFormed(s)
  })

  it('re-focuses the other pane rather than duplicating a file it holds', () => {
    // Right pane focused, holding only c.md; a.rs lives in the left pane.
    const s = openFile(split(), 'a.rs')
    expect(s.focused).toBe('left')
    expect(s.left.active).toBe('a.rs')
    expect(s.right!.tabs).toEqual(['c.md'])
    assertWellFormed(s)
  })
})

describe('closeTab', () => {
  it('activates the right-hand neighbour', () => {
    const s = closeTab(activateTab(three(), 'left', 'b.ts'), 'left', 'b.ts')
    expect(s.left.tabs).toEqual(['a.rs', 'c.md'])
    expect(s.left.active).toBe('c.md')
    assertWellFormed(s)
  })

  it('falls back to the left-hand neighbour for the last tab', () => {
    const s = closeTab(three(), 'left', 'c.md')
    expect(s.left.active).toBe('b.ts')
    assertWellFormed(s)
  })

  it('leaves the active tab alone when closing another one', () => {
    const s = closeTab(three(), 'left', 'a.rs')
    expect(s.left.active).toBe('c.md')
    assertWellFormed(s)
  })

  it('closing everything in a single pane leaves the empty state', () => {
    const s = ['c.md', 'b.ts', 'a.rs'].reduce((acc, p) => closeTab(acc, 'left', p), three())
    expect(s.left.tabs).toEqual([])
    expect(s.left.active).toBeNull()
    expect(s.right).toBeNull()
    assertWellFormed(s)
  })

  it('collapses the split when a pane empties, survivor keeps its tabs', () => {
    const s = closeTab(split(), 'right', 'c.md')
    expect(s.right).toBeNull()
    expect(s.focused).toBe('left')
    expect(s.left.tabs).toEqual(['a.rs', 'b.ts', 'c.md'])
    assertWellFormed(s)
  })

  it('collapses onto the right pane when the left one empties', () => {
    let s = split()
    for (const p of ['a.rs', 'b.ts', 'c.md']) s = closeTab(s, 'left', p)
    expect(s.right).toBeNull()
    expect(s.left.tabs).toEqual(['c.md'])
    expect(s.left.active).toBe('c.md')
    assertWellFormed(s)
  })

  it('is a no-op for a path that pane does not hold', () => {
    const s = three()
    expect(closeTab(s, 'left', 'nope.rs')).toBe(s)
    expect(closeTab(s, 'right', 'a.rs')).toBe(s)
  })
})

describe('splitPane / collapseSplit', () => {
  it('copies the active tab into a new focused right pane', () => {
    const s = split()
    expect(s.right!.tabs).toEqual(['c.md'])
    expect(s.right!.active).toBe('c.md')
    expect(s.left.tabs).toEqual(['a.rs', 'b.ts', 'c.md'])
    expect(s.focused).toBe('right')
    expect(s.ratio).toBe(DEFAULT_RATIO)
    assertWellFormed(s)
  })

  it('refuses to split twice, or with nothing open', () => {
    expect(splitPane(split())).toBeNull()
    expect(splitPane(emptyTabsState())).toBeNull()
  })

  it('collapses onto the focused pane', () => {
    expect(collapseSplit(split()).left.tabs).toEqual(['c.md'])
    expect(collapseSplit(focusPane(split(), 'left')).left.tabs).toEqual([
      'a.rs',
      'b.ts',
      'c.md',
    ])
    assertWellFormed(collapseSplit(split()))
  })

  it('is a no-op with no split to collapse', () => {
    const s = three()
    expect(collapseSplit(s)).toBe(s)
  })
})

describe('splitWithTab', () => {
  it('moves the dragged tab into a new right pane', () => {
    const s = splitWithTab(three(), { side: 'left', path: 'a.rs' })!
    expect(s.left.tabs).toEqual(['b.ts', 'c.md'])
    expect(s.right!.tabs).toEqual(['a.rs'])
    expect(s.focused).toBe('right')
    assertWellFormed(s)
  })

  it('refuses when it would empty the source pane, or when already split', () => {
    const one = openFile(emptyTabsState(), 'a.rs')
    expect(splitWithTab(one, { side: 'left', path: 'a.rs' })).toBeNull()
    expect(splitWithTab(split(), { side: 'left', path: 'a.rs' })).toBeNull()
  })
})

describe('dropIndex', () => {
  const rects: TabRect[] = [
    { left: 0, right: 100 },
    { left: 100, right: 200 },
    { left: 200, right: 300 },
  ]

  it('is the midpoint scheme', () => {
    expect(dropIndex(rects, 10)).toBe(0)
    expect(dropIndex(rects, 49)).toBe(0)
    expect(dropIndex(rects, 51)).toBe(1)
    expect(dropIndex(rects, 149)).toBe(1)
    expect(dropIndex(rects, 151)).toBe(2)
    expect(dropIndex(rects, 290)).toBe(3)
  })

  it('clamps outside the strip without a special case', () => {
    expect(dropIndex(rects, -500)).toBe(0)
    expect(dropIndex(rects, 5000)).toBe(3)
    expect(dropIndex([], 42)).toBe(0)
  })
})

describe('moveTab', () => {
  it('reorders within a strip', () => {
    const s = moveTab(three(), { side: 'left', path: 'c.md' }, 'left', 0)!
    expect(s.left.tabs).toEqual(['c.md', 'a.rs', 'b.ts'])
    expect(s.left.active).toBe('c.md')
    assertWellFormed(s)
  })

  it('accounts for the dragged tab leaving its own slot on a rightward move', () => {
    const s = moveTab(three(), { side: 'left', path: 'a.rs' }, 'left', 3)!
    expect(s.left.tabs).toEqual(['b.ts', 'c.md', 'a.rs'])
    assertWellFormed(s)
  })

  it('writes nothing for a drop on itself or back at its own index', () => {
    const s = three()
    expect(moveTab(s, { side: 'left', path: 'b.ts' }, 'left', 1)).toBeNull()
    expect(moveTab(s, { side: 'left', path: 'b.ts' }, 'left', 2)).toBeNull()
    expect(moveTab(s, { side: 'left', path: 'a.rs' }, 'left', 0)).toBeNull()
    expect(moveTab(s, { side: 'left', path: 'c.md' }, 'left', 3)).toBeNull()
  })

  it('writes nothing for an unknown tab or a pane that is not there', () => {
    const s = three()
    expect(moveTab(s, { side: 'left', path: 'nope.rs' }, 'left', 0)).toBeNull()
    expect(moveTab(s, { side: 'left', path: 'a.rs' }, 'right', 0)).toBeNull()
  })

  it('moves across panes at the drop index and activates it there', () => {
    const s = moveTab(split(), { side: 'left', path: 'a.rs' }, 'right', 1)!
    expect(s.left.tabs).toEqual(['b.ts', 'c.md'])
    expect(s.right!.tabs).toEqual(['c.md', 'a.rs'])
    expect(s.right!.active).toBe('a.rs')
    expect(s.focused).toBe('right')
    assertWellFormed(s)
  })

  it('never mints a third copy when the destination already holds the path', () => {
    // Left and right both hold c.md after a split; dragging the left copy
    // across just closes it, since the right pane is already showing it.
    expect(moveTab(split(), { side: 'left', path: 'c.md' }, 'right', 0)).toBeNull()
    const s = moveTab(
      moveTab(split(), { side: 'left', path: 'a.rs' }, 'right', 0)!,
      { side: 'left', path: 'c.md' },
      'right',
      0,
    )!
    expect(s.left.tabs).toEqual(['b.ts'])
    expect(s.right!.tabs).toEqual(['a.rs', 'c.md'])
    expect(s.right!.active).toBe('c.md')
    assertWellFormed(s)
  })

  it('collapses the split when the cross-pane move empties the source', () => {
    const s = moveTab(
      splitWithTab(three(), { side: 'left', path: 'a.rs' })!,
      { side: 'right', path: 'a.rs' },
      'left',
      0,
    )!
    expect(s.right).toBeNull()
    expect(s.left.tabs).toEqual(['a.rs', 'b.ts', 'c.md'])
    expect(s.left.active).toBe('a.rs')
    assertWellFormed(s)
  })
})

describe('ratio', () => {
  it('clamps to a pane neither side can zero out', () => {
    expect(clampRatio(0)).toBe(MIN_RATIO)
    expect(clampRatio(1)).toBe(MAX_RATIO)
    expect(clampRatio(0.4)).toBe(0.4)
    expect(clampRatio(Number.NaN)).toBe(DEFAULT_RATIO)
  })

  it('only applies while split', () => {
    const s = three()
    expect(setRatio(s, 0.3)).toBe(s)
    expect(setRatio(split(), 0.3).ratio).toBe(0.3)
  })
})

describe('openPaths', () => {
  it('deduplicates the path a split has in both panes', () => {
    expect(openPaths(split()).sort()).toEqual(['a.rs', 'b.ts', 'c.md'])
    expect(openPaths(emptyTabsState())).toEqual([])
  })
})

describe('focusPane', () => {
  it('cannot focus a pane that does not exist', () => {
    const s = three()
    expect(focusPane(s, 'right')).toBe(s)
    expect(focusPane(split(), 'left').focused).toBe('left')
  })
})

describe('cycleTab', () => {
  it('steps forward and back through the strip', () => {
    const s = three() // 'c.md' active, last of three
    expect(cycleTab(s, 'left', false)!.left.active).toBe('b.ts')
    expect(cycleTab(s, 'left', true)!.left.active).toBe('a.rs')
  })

  it('wraps at both ends rather than stopping', () => {
    const first = activateTab(three(), 'left', 'a.rs')
    expect(cycleTab(first, 'left', false)!.left.active).toBe('c.md')
    expect(cycleTab(first, 'left', true)!.left.active).toBe('b.ts')
  })

  it('steps the named pane only, and focuses it', () => {
    const s: TabsState = {
      left: { tabs: ['a.rs', 'b.ts'], active: 'a.rs' },
      right: { tabs: ['c.md', 'd.go'], active: 'c.md' },
      focused: 'left',
      ratio: DEFAULT_RATIO,
    }
    const next = cycleTab(s, 'right', true)!
    expect(next.right!.active).toBe('d.go')
    expect(next.left.active).toBe('a.rs')
    expect(next.focused).toBe('right')
  })

  it('is a no-op with nothing to step to', () => {
    expect(cycleTab(emptyTabsState(), 'left', true)).toBeNull()
    expect(cycleTab(three(), 'right', true)).toBeNull() // unsplit
    // A one-tab pane would wrap onto the tab already showing.
    expect(cycleTab(split(), 'right', true)).toBeNull()
  })

  it('leaves a well-formed state', () => {
    const s = cycleTab(three(), 'left', true)!
    assertWellFormed(s)
    expect(s.left.tabs).toEqual(['a.rs', 'b.ts', 'c.md'])
  })
})
