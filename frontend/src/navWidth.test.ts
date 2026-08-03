import { beforeEach, describe, expect, it } from 'vitest'
import {
  clampNavWidth,
  clearNavWidth,
  DEFAULT_NAV_WIDTH,
  loadNavWidth,
  MIN_NAV_WIDTH,
  saveNavWidth,
} from './navWidth'

describe('clampNavWidth', () => {
  it('passes an in-range width through untouched', () => {
    expect(clampNavWidth(300, 900)).toBe(300)
  })

  it('floors at MIN_NAV_WIDTH rather than collapsing', () => {
    expect(clampNavWidth(40, 900)).toBe(MIN_NAV_WIDTH)
    expect(clampNavWidth(-500, 900)).toBe(MIN_NAV_WIDTH)
  })

  it('ceilings at the live max so main keeps its floor', () => {
    expect(clampNavWidth(5000, 640)).toBe(640)
  })

  it('lets the floor win when the window leaves no room to grow', () => {
    // A narrow window can put main's floor left of the nav's own floor; the
    // result must still be renderable, never a max below the min.
    expect(clampNavWidth(300, 80)).toBe(MIN_NAV_WIDTH)
    expect(clampNavWidth(300, -100)).toBe(MIN_NAV_WIDTH)
  })

  it('falls back to the default on a non-finite width', () => {
    expect(clampNavWidth(NaN, 900)).toBe(DEFAULT_NAV_WIDTH)
    expect(clampNavWidth(Infinity, 900)).toBe(DEFAULT_NAV_WIDTH)
  })
})

describe('load/save/clear', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults when nothing is stored', () => {
    expect(loadNavWidth()).toBe(DEFAULT_NAV_WIDTH)
  })

  it('round-trips a saved width', () => {
    saveNavWidth(345)
    expect(loadNavWidth()).toBe(345)
  })

  it('defaults on a corrupt stored value instead of a broken shell', () => {
    for (const bad of ['', '   ', 'wide', 'null', '{"w":300}', 'NaN', '-1']) {
      localStorage.setItem('mesa-nav-width', bad)
      expect(loadNavWidth()).toBe(DEFAULT_NAV_WIDTH)
    }
  })

  it('defaults on a stored value below the floor', () => {
    saveNavWidth(MIN_NAV_WIDTH - 1)
    expect(loadNavWidth()).toBe(DEFAULT_NAV_WIDTH)
  })

  it('keeps an over-wide stored value for the drag clamp to pull in', () => {
    // The live ceiling depends on the current window, which this module can't
    // see — so an oversized value is loaded, then clamped on first render.
    saveNavWidth(4000)
    expect(loadNavWidth()).toBe(4000)
    expect(clampNavWidth(loadNavWidth(), 700)).toBe(700)
  })

  it('clear forgets the value rather than pinning the default', () => {
    saveNavWidth(345)
    clearNavWidth()
    expect(localStorage.getItem('mesa-nav-width')).toBeNull()
    expect(loadNavWidth()).toBe(DEFAULT_NAV_WIDTH)
  })
})
