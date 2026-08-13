import { describe, expect, it } from 'vitest'
import {
  playFailure,
  replaySlices,
  REWIND_STEP_SECONDS,
  rewindTarget,
  scheduleAt,
  SCHEDULE_LEAD_SECONDS,
} from './speechPlayback'

describe('playFailure', () => {
  const STREAM = '/api/inbox/7/speak'
  const ABSOLUTE = `http://192.168.1.4:7770${STREAM}`

  it('decodes the audio itself when the element will not play it', () => {
    expect(playFailure(ABSOLUTE, STREAM)).toBe('decode')
  })

  it('ignores a failure reported against no source at all', () => {
    // Stop clears the element's source. Whatever a browser then reports, it is
    // not the stream failing — treating it as one would restart what was just
    // stopped.
    expect(playFailure('', STREAM)).toBe('ignore')
    expect(playFailure('http://192.168.1.4:7770/#/inbox', STREAM)).toBe('ignore')
  })

  it('ignores a failure belonging to another item', () => {
    expect(playFailure(ABSOLUTE, '/api/inbox/8/speak')).toBe('ignore')
  })
})

describe('scheduleAt', () => {
  it('keeps a slot that is still ahead of the clock', () => {
    // Back-to-back is what makes decoded audio continuous: a buffer whose turn
    // has not come yet starts exactly when the one before it ends.
    expect(scheduleAt(4.2, 5)).toBe(5)
  })

  it('puts a buffer the network delivered late a lead ahead instead', () => {
    expect(scheduleAt(5.5, 5)).toBe(5.5 + SCHEDULE_LEAD_SECONDS)
  })

  it('leads the very first buffer, which has no slot yet', () => {
    expect(scheduleAt(9, 9)).toBe(9 + SCHEDULE_LEAD_SECONDS)
  })
})

describe('replaySlices', () => {
  // Four seconds of decoded audio in one-second pieces, as a sentence-by-
  // sentence render arrives.
  const held = [
    { at: 0, duration: 1 },
    { at: 1, duration: 1 },
    { at: 2, duration: 1 },
    { at: 3, duration: 1 },
  ]

  it('resumes inside the piece the target lands in', () => {
    // 1.5s back into the second piece: it sounds at once, half-way through,
    // and the ones after it keep their spacing from that moment.
    expect(replaySlices(held, 1.5)).toEqual([
      { index: 1, from: 0.5, delay: 0 },
      { index: 2, from: 0, delay: 0.5 },
      { index: 3, from: 0, delay: 1.5 },
    ])
  })

  it('drops the pieces entirely behind the target', () => {
    expect(replaySlices(held, 3).map((s) => s.index)).toEqual([3])
  })

  it('replays everything when the target is the start of the item', () => {
    expect(replaySlices(held, 0)).toEqual([
      { index: 0, from: 0, delay: 0 },
      { index: 1, from: 0, delay: 1 },
      { index: 2, from: 0, delay: 2 },
      { index: 3, from: 0, delay: 3 },
    ])
  })

  it('replays a piece the target lands exactly on from its start', () => {
    // The boundary is the case a `<=` in the wrong place turns into a skipped
    // piece or a repeated one.
    expect(replaySlices(held, 2)).toEqual([
      { index: 2, from: 0, delay: 0 },
      { index: 3, from: 0, delay: 1 },
    ])
  })

  it('has nothing to replay before the first piece arrives', () => {
    expect(replaySlices([], 0)).toEqual([])
  })
})

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
