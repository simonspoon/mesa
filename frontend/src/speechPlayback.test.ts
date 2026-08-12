import { describe, expect, it } from 'vitest'
import { playFailure, REWIND_STEP_SECONDS, rewindTarget } from './speechPlayback'

describe('playFailure', () => {
  const STREAM = '/api/inbox/7/speak'
  const ABSOLUTE = `http://192.168.1.4:7770${STREAM}`

  it('falls back to the buffered audio the first time the stream fails', () => {
    expect(playFailure(ABSOLUTE, STREAM, false)).toBe('buffer')
  })

  it('reports a stream that failed again after the fallback', () => {
    expect(playFailure(ABSOLUTE, STREAM, true)).toBe('report')
  })

  it('reports a blob that would not play — there is nothing left to try', () => {
    expect(playFailure('blob:http://localhost:7770/9f2c', STREAM, false)).toBe(
      'report',
    )
  })

  it('ignores a failure reported against no source at all', () => {
    // Stop clears the element's source. Whatever a browser then reports, it is
    // not the stream failing — treating it as one would restart what was just
    // stopped.
    expect(playFailure('', STREAM, false)).toBe('ignore')
    expect(playFailure('http://192.168.1.4:7770/#/inbox', STREAM, false)).toBe(
      'ignore',
    )
  })

  it('ignores a failure belonging to another item', () => {
    expect(playFailure(`${ABSOLUTE}`, '/api/inbox/8/speak', false)).toBe(
      'ignore',
    )
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
