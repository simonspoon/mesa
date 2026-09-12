import { beforeEach, describe, expect, it } from 'vitest'
import {
  clampLiveSidebarWidth,
  clearLiveSidebarWidth,
  DEFAULT_LIVE_SIDEBAR_WIDTH,
  loadLiveSidebarWidth,
  MIN_LIVE_SIDEBAR_WIDTH,
  saveLiveSidebarWidth,
} from './liveSidebarWidth'

describe('clampLiveSidebarWidth', () => {
  it('passes an in-range width through untouched', () => {
    expect(clampLiveSidebarWidth(500, 1600)).toBe(500)
  })

  it('floors at MIN_LIVE_SIDEBAR_WIDTH rather than collapsing to a slit', () => {
    expect(clampLiveSidebarWidth(40, 1600)).toBe(MIN_LIVE_SIDEBAR_WIDTH)
    expect(clampLiveSidebarWidth(-500, 1600)).toBe(MIN_LIVE_SIDEBAR_WIDTH)
  })

  it('ceilings at the room measured by the caller so main keeps its floor', () => {
    expect(clampLiveSidebarWidth(5000, 1200)).toBe(1200)
  })

  it('lets the floor win when the window leaves no room to grow', () => {
    expect(clampLiveSidebarWidth(900, 200)).toBe(MIN_LIVE_SIDEBAR_WIDTH)
    expect(clampLiveSidebarWidth(900, -100)).toBe(MIN_LIVE_SIDEBAR_WIDTH)
  })

  it('answers the floor on a non-finite width, there being no numeric default', () => {
    expect(clampLiveSidebarWidth(NaN, 1600)).toBe(MIN_LIVE_SIDEBAR_WIDTH)
    expect(clampLiveSidebarWidth(Infinity, 1600)).toBe(MIN_LIVE_SIDEBAR_WIDTH)
  })
})

describe('width load/save/clear', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('has no opinion when nothing is stored, so the stylesheet decides', () => {
    expect(loadLiveSidebarWidth()).toBe(DEFAULT_LIVE_SIDEBAR_WIDTH)
    expect(DEFAULT_LIVE_SIDEBAR_WIDTH).toBeNull()
  })

  it('round-trips a saved width — the panel survives a reload', () => {
    saveLiveSidebarWidth(520)
    expect(loadLiveSidebarWidth()).toBe(520)
  })

  it('has no opinion on a corrupt stored value instead of a broken layout', () => {
    for (const bad of ['', '   ', 'wide', 'null', '{"w":500}', 'NaN', '-1']) {
      localStorage.setItem('mesa-live-sidebar-width', bad)
      expect(loadLiveSidebarWidth()).toBeNull()
    }
  })

  it('has no opinion on a stored value below the floor', () => {
    localStorage.setItem('mesa-live-sidebar-width', String(MIN_LIVE_SIDEBAR_WIDTH - 1))
    expect(loadLiveSidebarWidth()).toBeNull()
  })

  it('keeps an over-wide stored value for the next drag to pull in', () => {
    // The live ceiling depends on the current window, which this module can't
    // see; the render caps it and the next drag stores a clamped value.
    saveLiveSidebarWidth(4000)
    expect(loadLiveSidebarWidth()).toBe(4000)
    expect(clampLiveSidebarWidth(4000, 1200)).toBe(1200)
  })

  it('clear forgets the value rather than pinning a number over the CSS rule', () => {
    saveLiveSidebarWidth(520)
    clearLiveSidebarWidth()
    expect(localStorage.getItem('mesa-live-sidebar-width')).toBeNull()
    expect(loadLiveSidebarWidth()).toBeNull()
  })
})
