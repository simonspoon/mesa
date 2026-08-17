import { beforeEach, describe, expect, it } from 'vitest'
import type { ClientRect } from '@dnd-kit/core'
import {
  closePane,
  dropTab,
  fillsViewport,
  getLayout,
  isEmpty,
  PANE_TABS,
  normalizeRatios,
  paneTabs,
  parseLayout,
  taskHrefFrom,
  setLayout,
  singlePane,
  type PaneRoot,
} from './projectPanes'

// One pane's box, 400x200 at the origin — the rect every drop below is
// measured against.
const rect: ClientRect = {
  top: 0,
  left: 0,
  right: 400,
  bottom: 200,
  width: 400,
  height: 200,
}

const CENTER = { x: 200, y: 100 }
const RIGHT_EDGE = { x: 380, y: 100 }
const LEFT_EDGE = { x: 20, y: 100 }
const BOTTOM_EDGE = { x: 200, y: 190 }

/** The tree's shape as a nested string, so a test asserts on layout rather
 *  than on ids and ratios: `row(board, files)`. */
function shape(root: PaneRoot): string {
  function walk(node: PaneRoot['children'][number]['node']): string {
    if (node.kind === 'leaf') return node.id
    return `${node.orientation}(${node.children.map((c) => walk(c.node)).join(', ')})`
  }
  return walk(root)
}

describe('dropTab', () => {
  it('drops onto the right edge of the only pane as a side-by-side split', () => {
    const next = dropTab(singlePane('board'), 'files', 'board', RIGHT_EDGE, rect)
    expect(shape(next)).toBe('row(board, files)')
  })

  it('drops onto the left edge ahead of the target', () => {
    const next = dropTab(singlePane('board'), 'files', 'board', LEFT_EDGE, rect)
    expect(shape(next)).toBe('row(files, board)')
  })

  it('drops onto the bottom edge as a stack', () => {
    const next = dropTab(singlePane('board'), 'files', 'board', BOTTOM_EDGE, rect)
    // Root keeps its own orientation and holds the new column split as its
    // single child — the same tree a `row` root with one stacked pair is.
    expect(shape(next)).toBe('row(column(board, files))')
  })

  it('drops onto the center as a sibling of the target, no new split', () => {
    // The dropped view takes the target's own slot, pushing it along — the
    // same "insert at that index" the shared engine's center zone has always
    // meant, pinned here so the order cannot drift silently.
    const next = dropTab(singlePane('board'), 'files', 'board', CENTER, rect)
    expect(shape(next)).toBe('row(files, board)')
  })

  it('moves an already-open view instead of opening a second copy', () => {
    const two = dropTab(singlePane('board'), 'files', 'board', RIGHT_EDGE, rect)
    const three = dropTab(two, 'git', 'files', BOTTOM_EDGE, rect)
    expect(paneTabs(three)).toEqual(['board', 'files', 'git'])
    // git already has a pane; dragging it onto the board's bottom edge must
    // relocate that one pane, never add a fourth leaf.
    const moved = dropTab(three, 'git', 'board', BOTTOM_EDGE, rect)
    expect(paneTabs(moved).sort()).toEqual(['board', 'files', 'git'])
    expect(shape(moved)).toBe('row(column(board, git), files)')
  })

  it('is a no-op when a tab is dropped onto its own pane', () => {
    const one = singlePane('board')
    expect(dropTab(one, 'board', 'board', RIGHT_EDGE, rect)).toBe(one)
  })

  it('appends when the drop target is not in the tree', () => {
    const next = dropTab(singlePane('board'), 'files', 'nonesuch', CENTER, rect)
    expect(paneTabs(next).sort()).toEqual(['board', 'files'])
  })

  it('starts a fresh tree when the only pane is the one being dragged', () => {
    const next = dropTab(singlePane('board'), 'board', 'ghost', CENTER, rect)
    expect(paneTabs(next)).toEqual(['board'])
  })
})

describe('normalizeRatios', () => {
  it('keeps every split summing to at least 1, so flexbox fills the row', () => {
    // Two successive splits of the same pair used to walk the ratio budget
    // down (1 → 0.5 → 0.25) and leave half the tab empty.
    const two = dropTab(singlePane('board'), 'files', 'board', RIGHT_EDGE, rect)
    const flipped = dropTab(two, 'files', 'board', LEFT_EDGE, rect)
    const sum = flipped.children.reduce((s, c) => s + c.ratio, 0)
    expect(shape(flipped)).toBe('row(files, board)')
    expect(sum).toBeCloseTo(2)
  })

  it('preserves the proportions a divider drag set', () => {
    const two = dropTab(singlePane('board'), 'files', 'board', RIGHT_EDGE, rect)
    const dragged: PaneRoot = {
      ...two,
      children: [
        { ...two.children[0], ratio: 0.25 },
        { ...two.children[1], ratio: 0.75 },
      ],
    }
    const ratios = normalizeRatios(dragged).children.map((c) => c.ratio)
    expect(ratios[1] / ratios[0]).toBeCloseTo(3)
    expect(ratios[0] + ratios[1]).toBeCloseTo(2)
  })
})

describe('taskHrefFrom', () => {
  it('keeps a task opened from a Custom pane on the Custom route', () => {
    expect(taskHrefFrom('#/projects/7/custom', 7, 12)).toBe('#/projects/7/custom/tasks/12')
    expect(taskHrefFrom('#/projects/7/custom/tasks/9', 7, 12)).toBe('#/projects/7/custom/tasks/12')
  })

  it('is the plain task route everywhere else', () => {
    expect(taskHrefFrom('#/projects/7', 7, 12)).toBe('#/projects/7/tasks/12')
    expect(taskHrefFrom('#/projects/7/files', 7, 12)).toBe('#/projects/7/tasks/12')
    // Another project's Custom layout is not this card's project.
    expect(taskHrefFrom('#/projects/8/custom', 7, 12)).toBe('#/projects/7/tasks/12')
  })
})

describe('fillsViewport', () => {
  it('is the tabs whose whole body is a box, not a column', () => {
    expect(fillsViewport('files')).toBe(true)
    expect(fillsViewport('terminal')).toBe(true)
  })

  it('leaves every flowing tab scrolling in main', () => {
    // Git and the Diagrams index flow a header/list down the page, so they
    // keep the document-flow frame even though Git's diff pane is bounded.
    for (const tab of ['board', 'dashboard', 'diagrams', 'git', 'settings'] as const)
      expect(fillsViewport(tab)).toBe(false)
  })

  it('answers for every tab on the strip', () => {
    for (const tab of PANE_TABS) expect(typeof fillsViewport(tab)).toBe('boolean')
  })
})

describe('closePane', () => {
  it('drops that view and leaves the rest', () => {
    const two = dropTab(singlePane('board'), 'files', 'board', RIGHT_EDGE, rect)
    expect(paneTabs(closePane(two, 'board'))).toEqual(['files'])
  })

  it('empties the tree when the last pane closes', () => {
    expect(isEmpty(closePane(singlePane('board'), 'board'))).toBe(true)
  })
})

describe('parseLayout', () => {
  it('reads back a tree it wrote', () => {
    const two = dropTab(singlePane('board'), 'files', 'board', RIGHT_EDGE, rect)
    const round = parseLayout(JSON.parse(JSON.stringify(two)))
    expect(round && shape(round)).toBe('row(board, files)')
  })

  it('rejects an unknown view, a malformed node and a non-split root', () => {
    expect(parseLayout({ kind: 'split', orientation: 'row', children: [{ ratio: 1, node: { kind: 'leaf', id: 'nope' } }] })).toBeNull()
    expect(parseLayout({ kind: 'split', orientation: 'sideways', children: [] })).toBeNull()
    expect(parseLayout({ kind: 'leaf', id: 'board' })).toBeNull()
    expect(parseLayout('board')).toBeNull()
    expect(parseLayout(null)).toBeNull()
  })

  it('rejects a tree holding the same view twice', () => {
    const dup = {
      kind: 'split',
      id: 's',
      orientation: 'row',
      children: [
        { ratio: 1, node: { kind: 'leaf', contentKind: 'view', id: 'board' } },
        { ratio: 1, node: { kind: 'leaf', contentKind: 'view', id: 'board' } },
      ],
    }
    expect(parseLayout(dup)).toBeNull()
  })

  it('falls back to the default ratio for a missing or absurd one', () => {
    const root = parseLayout({
      kind: 'split',
      id: 's',
      orientation: 'row',
      children: [
        { node: { kind: 'leaf', contentKind: 'view', id: 'board' } },
        { ratio: -3, node: { kind: 'leaf', contentKind: 'view', id: 'files' } },
      ],
    })
    expect(root?.children.map((c) => c.ratio)).toEqual([1, 1])
  })
})

describe('the per-project memory', () => {
  beforeEach(() => localStorage.clear())

  it('remembers a layout per project', () => {
    const two = dropTab(singlePane('board'), 'files', 'board', RIGHT_EDGE, rect)
    setLayout(7, two)
    setLayout(8, singlePane('git'))
    expect(paneTabs(getLayout(7)!)).toEqual(['board', 'files'])
    expect(paneTabs(getLayout(8)!)).toEqual(['git'])
    expect(getLayout(9)).toBeNull()
  })

  it('forgets a project whose last pane closed', () => {
    setLayout(7, singlePane('board'))
    setLayout(7, closePane(singlePane('board'), 'board'))
    expect(getLayout(7)).toBeNull()
  })

  it('reads unparseable storage as no memory at all', () => {
    localStorage.setItem('mesa-project-panes', '{not json')
    expect(getLayout(7)).toBeNull()
    localStorage.setItem('mesa-project-panes', '[]')
    expect(getLayout(7)).toBeNull()
    localStorage.setItem('mesa-project-panes', JSON.stringify({ 7: { kind: 'leaf', id: 'board' } }))
    expect(getLayout(7)).toBeNull()
  })
})
