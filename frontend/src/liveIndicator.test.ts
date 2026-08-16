import { describe, expect, it } from 'vitest'
import { headerIndicator, indicatorLabel } from './liveIndicator'

function input(patch: Partial<Parameters<typeof headerIndicator>[0]> = {}) {
  return {
    live: true,
    joined: true,
    speaking: false,
    recognizes: true,
    interim: '',
    draft: '',
    ...patch,
  }
}

describe('headerIndicator', () => {
  it('says nothing with no conversation, or one this browser has not joined', () => {
    expect(headerIndicator(input({ live: false }))).toBeNull()
    expect(headerIndicator(input({ joined: false }))).toBeNull()
    // Words in the box do not change that: the box is disabled when the
    // conversation is not live, and a browser that never pressed is watching.
    expect(headerIndicator(input({ live: false, draft: 'hello' }))).toBeNull()
    expect(headerIndicator(input({ joined: false, interim: 'hello' }))).toBeNull()
  })

  it('rests on listening only where the microphone is the way in', () => {
    expect(headerIndicator(input())).toBe('listening')
    // A browser typing into the fallback box has nothing ambient to report.
    expect(headerIndicator(input({ recognizes: false }))).toBeNull()
  })

  it('reports being heard, by either route in', () => {
    expect(headerIndicator(input({ interim: 'the quick brown' }))).toBe('hearing')
    expect(headerIndicator(input({ draft: 'typed at it' }))).toBe('hearing')
    // The typed box is the fallback surface, so it reports without a recognizer.
    expect(headerIndicator(input({ recognizes: false, draft: 'typed at it' }))).toBe(
      'hearing',
    )
    // Whitespace is not speech: an engine settling on a blank interim, or a
    // box holding a stray newline, must not read as the person talking.
    expect(headerIndicator(input({ interim: '  ', draft: '\n' }))).toBe('listening')
  })

  it('lets mesa speaking outrank both', () => {
    // While she speaks the microphone is shut, so a band claiming to hear the
    // person would be describing a microphone that is not open.
    expect(headerIndicator(input({ speaking: true }))).toBe('speaking')
    expect(headerIndicator(input({ speaking: true, interim: 'over her' }))).toBe(
      'speaking',
    )
    expect(headerIndicator(input({ speaking: true, draft: 'over her' }))).toBe(
      'speaking',
    )
    // The tail of a reply outlasting the session still shows what is sounding.
    expect(headerIndicator(input({ speaking: true, live: false, joined: false }))).toBe(
      'speaking',
    )
  })
})

describe('indicatorLabel', () => {
  it('names who is talking, in each state', () => {
    expect(indicatorLabel('speaking')).toBe('mesa is speaking')
    expect(indicatorLabel('hearing')).toBe('mesa is hearing you')
    expect(indicatorLabel('listening')).toBe('mesa is listening')
  })
})
