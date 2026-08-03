import { describe, expect, it } from 'vitest'
import {
  ancestorIds,
  buildTree,
  descendantIds,
  effectivelyArchivedIds,
  hasChildren,
  todoCountFor,
  visibleRows,
  type TreeNode,
} from './projectTree'

// One server-ordered array (`ORDER BY sort_order, id`), three levels deep:
//
//   1 root
//     10 child
//       100 grandchild
//     11 child
//   2 other root
const list: TreeNode[] = [
  { id: 1, parent_id: null },
  { id: 10, parent_id: 1 },
  { id: 100, parent_id: 10 },
  { id: 11, parent_id: 1 },
  { id: 2, parent_id: null },
]

const shape = (rows: { project: TreeNode; depth: number }[]) =>
  rows.map((r) => [r.project.id, r.depth])

describe('buildTree', () => {
  it('nests children under their parent with a depth per level', () => {
    expect(shape(buildTree(list))).toEqual([
      [1, 0],
      [10, 1],
      [100, 2],
      [11, 1],
      [2, 0],
    ])
  })

  it('keeps siblings in the order the server gave', () => {
    // Reversed input, same parents: the tree follows the array, never ids.
    const reordered: TreeNode[] = [
      { id: 1, parent_id: null },
      { id: 11, parent_id: 1 },
      { id: 10, parent_id: 1 },
    ]
    expect(shape(buildTree(reordered))).toEqual([
      [1, 0],
      [11, 1],
      [10, 1],
    ])
  })

  it('renders a child whose parent is absent from the array at top level', () => {
    // The live child of an archived parent, in the sidebar's active list: its
    // parent was filtered out, and it must still be reachable.
    expect(shape(buildTree([{ id: 10, parent_id: 1 }]))).toEqual([[10, 0]])
  })

  it('does not hang on a malformed cycle, and emits every row once', () => {
    const cyclic: TreeNode[] = [
      { id: 1, parent_id: 2 },
      { id: 2, parent_id: 1 },
      { id: 3, parent_id: null },
    ]
    const rows = buildTree(cyclic)
    expect(rows.map((r) => r.project.id).sort()).toEqual([1, 2, 3])
  })

  it('returns nothing for an empty list', () => {
    expect(buildTree([])).toEqual([])
  })
})

describe('descendantIds', () => {
  it('collects the whole subtree, excluding the project itself', () => {
    expect(descendantIds(list, 1).sort((a, b) => a - b)).toEqual([10, 11, 100])
    expect(descendantIds(list, 10)).toEqual([100])
    expect(descendantIds(list, 100)).toEqual([])
    expect(descendantIds(list, 2)).toEqual([])
  })

  it('terminates on a cycle', () => {
    const cyclic: TreeNode[] = [
      { id: 1, parent_id: 2 },
      { id: 2, parent_id: 1 },
    ]
    expect(descendantIds(cyclic, 1)).toEqual([2])
  })
})

describe('ancestorIds', () => {
  it('walks up, nearest first', () => {
    expect(ancestorIds(list, 100)).toEqual([10, 1])
    expect(ancestorIds(list, 1)).toEqual([])
  })

  it('terminates on a cycle', () => {
    const cyclic: TreeNode[] = [
      { id: 1, parent_id: 2 },
      { id: 2, parent_id: 1 },
    ]
    // Stops the moment the walk revisits the row it started from.
    expect(ancestorIds(cyclic, 1)).toEqual([2])
  })
})

describe('todoCountFor', () => {
  const counts = new Map([
    [1, 2],
    [10, 3],
    [100, 4],
  ])

  it('shows a project its own count while expanded', () => {
    // The descendants are on screen with their own badges; summing here would
    // show the same task twice.
    expect(todoCountFor(list, counts, 1, false)).toBe(2)
  })

  it('sums the subtree once collapsed, so nothing is hidden', () => {
    expect(todoCountFor(list, counts, 1, true)).toBe(9)
    expect(todoCountFor(list, counts, 10, true)).toBe(7)
  })

  it('is 0 for a project with no todos either way', () => {
    expect(todoCountFor(list, counts, 2, true)).toBe(0)
    expect(todoCountFor(list, counts, 2, false)).toBe(0)
  })
})

describe('visibleRows', () => {
  const rows = buildTree(list)

  it('hides a collapsed subtree but keeps the row you collapsed', () => {
    const visible = visibleRows(rows, (id) => id === 1)
    expect(visible.map((r) => r.project.id)).toEqual([1, 2])
  })

  it('hides descendants of a collapsed row at any depth', () => {
    const visible = visibleRows(rows, (id) => id === 10)
    expect(visible.map((r) => r.project.id)).toEqual([1, 10, 11, 2])
  })

  it('keeps a row whose collapsed parent is not in this list', () => {
    // The archived-parent case again: id 1 is collapsed, but the only row
    // here is its orphaned child, which `buildTree` put at top level.
    const orphan = buildTree([{ id: 10, parent_id: 1 }])
    expect(visibleRows(orphan, (id) => id === 1).map((r) => r.project.id)).toEqual([10])
  })

  it('shows everything when nothing is collapsed', () => {
    expect(visibleRows(rows, () => false)).toHaveLength(rows.length)
  })
})

describe('effectivelyArchivedIds', () => {
  const withFlags = (archived: number[]) =>
    list.map((p) => ({ ...p, archived: archived.includes(p.id) }))

  it('hides the archived project and everything under it', () => {
    // Archiving the root takes its child and grandchild with it, though
    // neither row's own flag was written.
    expect(effectivelyArchivedIds(withFlags([1]))).toEqual(new Set([1, 10, 100, 11]))
  })

  it('leaves an unrelated subtree alone', () => {
    expect(effectivelyArchivedIds(withFlags([10]))).toEqual(new Set([10, 100]))
  })

  it('is empty when nothing is archived', () => {
    expect(effectivelyArchivedIds(withFlags([]))).toEqual(new Set())
  })

  it('terminates on a cycle', () => {
    const cyclic = [
      { id: 1, parent_id: 2, archived: true },
      { id: 2, parent_id: 1, archived: false },
    ]
    expect(effectivelyArchivedIds(cyclic)).toEqual(new Set([1, 2]))
  })
})

describe('hasChildren', () => {
  it('is true only for a project something is nested under', () => {
    expect(hasChildren(list, 1)).toBe(true)
    expect(hasChildren(list, 10)).toBe(true)
    expect(hasChildren(list, 100)).toBe(false)
    expect(hasChildren(list, 2)).toBe(false)
  })
})
