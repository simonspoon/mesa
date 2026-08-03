import { beforeEach, describe, expect, it } from 'vitest'
import {
  clampFilesTreeWidth,
  clearFilesTreeWidth,
  DEFAULT_FILES_TREE_WIDTH,
  loadFilesTreeCollapsed,
  loadFilesTreeWidth,
  MIN_FILES_TREE_WIDTH,
  saveFilesTreeCollapsed,
  saveFilesTreeWidth,
} from './filesTreeWidth'

describe('clampFilesTreeWidth', () => {
  it('passes an in-range width through untouched', () => {
    expect(clampFilesTreeWidth(400, 900)).toBe(400)
  })

  it('floors at MIN_FILES_TREE_WIDTH rather than collapsing', () => {
    expect(clampFilesTreeWidth(40, 900)).toBe(MIN_FILES_TREE_WIDTH)
    expect(clampFilesTreeWidth(-500, 900)).toBe(MIN_FILES_TREE_WIDTH)
  })

  it('ceilings at the live max so the content half keeps its floor', () => {
    expect(clampFilesTreeWidth(5000, 640)).toBe(640)
  })

  it('lets the floor win when the layout leaves no room to grow', () => {
    // A narrow window can put the content half's floor left of the tree's own
    // floor; the result must still be renderable, never a max below the min.
    expect(clampFilesTreeWidth(400, 80)).toBe(MIN_FILES_TREE_WIDTH)
    expect(clampFilesTreeWidth(400, -100)).toBe(MIN_FILES_TREE_WIDTH)
  })

  it('falls back to the default on a non-finite width', () => {
    expect(clampFilesTreeWidth(NaN, 900)).toBe(DEFAULT_FILES_TREE_WIDTH)
    expect(clampFilesTreeWidth(Infinity, 900)).toBe(DEFAULT_FILES_TREE_WIDTH)
  })
})

describe('width load/save/clear', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults when nothing is stored', () => {
    expect(loadFilesTreeWidth()).toBe(DEFAULT_FILES_TREE_WIDTH)
  })

  it('round-trips a saved width', () => {
    saveFilesTreeWidth(420)
    expect(loadFilesTreeWidth()).toBe(420)
  })

  it('defaults on a corrupt stored value instead of a broken layout', () => {
    for (const bad of ['', '   ', 'wide', 'null', '{"w":300}', 'NaN', '-1']) {
      localStorage.setItem('mesa-files-tree-width', bad)
      expect(loadFilesTreeWidth()).toBe(DEFAULT_FILES_TREE_WIDTH)
    }
  })

  it('defaults on a stored value below the floor', () => {
    saveFilesTreeWidth(MIN_FILES_TREE_WIDTH - 1)
    expect(loadFilesTreeWidth()).toBe(DEFAULT_FILES_TREE_WIDTH)
  })

  it('keeps an over-wide stored value for the mount clamp to pull in', () => {
    // The live ceiling depends on the current layout, which this module can't
    // see — so an oversized value is loaded, then clamped on first render.
    saveFilesTreeWidth(4000)
    expect(loadFilesTreeWidth()).toBe(4000)
    expect(clampFilesTreeWidth(loadFilesTreeWidth(), 700)).toBe(700)
  })

  it('clear forgets the value rather than pinning the default', () => {
    saveFilesTreeWidth(420)
    clearFilesTreeWidth()
    expect(localStorage.getItem('mesa-files-tree-width')).toBeNull()
    expect(loadFilesTreeWidth()).toBe(DEFAULT_FILES_TREE_WIDTH)
  })
})

describe('collapsed flag', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('reads expanded when nothing is stored', () => {
    expect(loadFilesTreeCollapsed()).toBe(false)
  })

  it('round-trips both ways', () => {
    saveFilesTreeCollapsed(true)
    expect(loadFilesTreeCollapsed()).toBe(true)
    saveFilesTreeCollapsed(false)
    expect(loadFilesTreeCollapsed()).toBe(false)
  })

  it('reads expanded on a garbage stored value', () => {
    for (const bad of ['', '1', 'yes', 'TRUE', '{"collapsed":true}']) {
      localStorage.setItem('mesa-files-tree-collapsed', bad)
      expect(loadFilesTreeCollapsed()).toBe(false)
    }
  })
})
