import { beforeEach, describe, expect, it } from 'vitest'
import {
  clampLiveBoardWidth,
  clearLiveBoardWidth,
  DEFAULT_LIVE_BOARD_WIDTH,
  loadLiveBoardWidth,
  MIN_LIVE_BOARD_WIDTH,
  saveLiveBoardWidth,
} from './liveBoardWidth'

describe('clampLiveBoardWidth', () => {
  it('passes an in-range width through untouched', () => {
    expect(clampLiveBoardWidth(900, 1600)).toBe(900)
  })

  it('floors at MIN_LIVE_BOARD_WIDTH rather than collapsing to a strip', () => {
    expect(clampLiveBoardWidth(40, 1600)).toBe(MIN_LIVE_BOARD_WIDTH)
    expect(clampLiveBoardWidth(-500, 1600)).toBe(MIN_LIVE_BOARD_WIDTH)
  })

  it('ceilings at the main slot so the board never reaches over the nav', () => {
    expect(clampLiveBoardWidth(5000, 1200)).toBe(1200)
  })

  it('lets the floor win when the window leaves no room to grow', () => {
    expect(clampLiveBoardWidth(900, 200)).toBe(MIN_LIVE_BOARD_WIDTH)
    expect(clampLiveBoardWidth(900, -100)).toBe(MIN_LIVE_BOARD_WIDTH)
  })

  it('answers the floor on a non-finite width, there being no numeric default', () => {
    expect(clampLiveBoardWidth(NaN, 1600)).toBe(MIN_LIVE_BOARD_WIDTH)
    expect(clampLiveBoardWidth(Infinity, 1600)).toBe(MIN_LIVE_BOARD_WIDTH)
  })
})

describe('width load/save/clear', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('has no opinion when nothing is stored, so the stylesheet decides', () => {
    expect(loadLiveBoardWidth()).toBe(DEFAULT_LIVE_BOARD_WIDTH)
    expect(DEFAULT_LIVE_BOARD_WIDTH).toBeNull()
  })

  it('round-trips a saved width — the panel survives a remount', () => {
    saveLiveBoardWidth(1024)
    expect(loadLiveBoardWidth()).toBe(1024)
  })

  it('has no opinion on a corrupt stored value instead of a broken layout', () => {
    for (const bad of ['', '   ', 'wide', 'null', '{"w":900}', 'NaN', '-1']) {
      localStorage.setItem('mesa-live-board-width', bad)
      expect(loadLiveBoardWidth()).toBeNull()
    }
  })

  it('has no opinion on a stored value below the floor', () => {
    localStorage.setItem('mesa-live-board-width', String(MIN_LIVE_BOARD_WIDTH - 1))
    expect(loadLiveBoardWidth()).toBeNull()
  })

  it('keeps an over-wide stored value for the render to cap', () => {
    // The live ceiling depends on the current window, which this module can't
    // see — `.live-board`'s `max-width: 100%` holds it until the next drag.
    saveLiveBoardWidth(4000)
    expect(loadLiveBoardWidth()).toBe(4000)
    expect(clampLiveBoardWidth(4000, 1200)).toBe(1200)
  })

  it('clear forgets the value rather than pinning a number over the CSS rule', () => {
    saveLiveBoardWidth(1024)
    clearLiveBoardWidth()
    expect(localStorage.getItem('mesa-live-board-width')).toBeNull()
    expect(loadLiveBoardWidth()).toBeNull()
  })
})
