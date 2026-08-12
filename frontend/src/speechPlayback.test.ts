import { describe, expect, it } from 'vitest'
import { REWIND_STEP_SECONDS, rewindTarget } from './speechPlayback'

describe('rewindTarget', () => {
  it('goes back one step when that much is still seekable', () => {
    expect(rewindTarget(42, 0)).toBe(42 - REWIND_STEP_SECONDS)
  })

  it('clamps to the earliest seekable second rather than to zero', () => {
    // A stream that has dropped its start is seekable from 30s on, so a press
    // at 34s lands at 30s — never before what the player can still reach.
    expect(rewindTarget(34, 30)).toBe(30)
  })

  it('does nothing when the playhead is already at the earliest second', () => {
    expect(rewindTarget(0, 0)).toBeNull()
    expect(rewindTarget(30, 30)).toBeNull()
  })

  it('does nothing while nothing is seekable yet', () => {
    expect(rewindTarget(3, null)).toBeNull()
  })

  it('does nothing on the numbers a not-yet-started stream reports', () => {
    expect(rewindTarget(Number.NaN, 0)).toBeNull()
    expect(rewindTarget(12, Number.NaN)).toBeNull()
    expect(rewindTarget(Number.POSITIVE_INFINITY, 0)).toBeNull()
  })

  it('never seeks forward when the playhead is behind the window', () => {
    // A live stream can transiently report a playhead earlier than the range
    // it still holds; a rewind must not become a skip ahead.
    expect(rewindTarget(3, 30)).toBeNull()
  })
})
