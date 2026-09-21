import { describe, expect, it } from 'vitest'
import { nextResizeFrame } from './ptyResize'

describe('nextResizeFrame', () => {
  it('sends the first real geometry', () => {
    expect(nextResizeFrame(null, { cols: 80, rows: 24 })).toEqual({ cols: 80, rows: 24 })
  })

  it('drops a repeat of the last sent geometry', () => {
    expect(nextResizeFrame({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBeNull()
  })

  it('sends again after the geometry moves and comes back', () => {
    // A drag that ends where it started is still two real sizes for the TUI:
    // the intermediate one was sent, so the return is news.
    const away = nextResizeFrame({ cols: 80, rows: 24 }, { cols: 100, rows: 24 })
    expect(away).toEqual({ cols: 100, rows: 24 })
    expect(nextResizeFrame(away, { cols: 80, rows: 24 })).toEqual({ cols: 80, rows: 24 })
  })

  it("refuses xterm's degenerate clamp (2x1)", () => {
    expect(nextResizeFrame(null, { cols: 2, rows: 1 })).toBeNull()
  })

  it('refuses a NaN dimension', () => {
    expect(nextResizeFrame(null, { cols: Number.NaN, rows: 24 })).toBeNull()
    expect(nextResizeFrame(null, { cols: 80, rows: Number.NaN })).toBeNull()
  })

  it('passes a narrow but real pane (20x8)', () => {
    expect(nextResizeFrame(null, { cols: 20, rows: 8 })).toEqual({ cols: 20, rows: 8 })
  })
})
