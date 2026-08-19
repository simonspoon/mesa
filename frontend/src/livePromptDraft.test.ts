import { describe, expect, it } from 'vitest'
import {
  MAX_AUTO_SEND_MS,
  MAX_LIVE_PROMPT,
  MIN_AUTO_SEND_MS,
  changedLive,
  draftFrom,
  isDirty,
  isSavable,
  usesDefault,
  valueError,
  waitError,
} from './livePromptDraft'
import type { ConfigLive } from './types/ConfigLive'

const BUILT_IN = 'You are the voice of mesa in a live conversation.'
const DEFAULTED: ConfigLive = {
  prompt: null,
  default_prompt: BUILT_IN,
  auto_send_ms: null,
  auto_send_ms_default: 2000,
}
const SET: ConfigLive = {
  prompt: 'Be brief.',
  default_prompt: BUILT_IN,
  auto_send_ms: 4500,
  auto_send_ms_default: 2000,
}

/** A draft holding the two boxes, so a test names only the one it is about. */
const draft = (prompt = '', auto_send_ms = '') => ({ prompt, auto_send_ms })

describe('draftFrom', () => {
  it('renders an unconfigured prompt blank and a configured one as text', () => {
    expect(draftFrom(DEFAULTED)).toEqual({ prompt: '', auto_send_ms: '' })
    expect(draftFrom(SET)).toEqual({ prompt: 'Be brief.', auto_send_ms: '4500' })
  })

  it('reports a freshly loaded section as pristine', () => {
    expect(isDirty(DEFAULTED, draftFrom(DEFAULTED))).toBe(false)
    expect(isDirty(SET, draftFrom(SET))).toBe(false)
  })
})

describe('usesDefault', () => {
  it('is true exactly while the box is blank', () => {
    expect(usesDefault(draft(''))).toBe(true)
    expect(usesDefault(draft('  '))).toBe(true)
    expect(usesDefault(draft('Be brief.'))).toBe(false)
  })
})

describe('valueError', () => {
  it('accepts blank — that is the reset, not a mistake', () => {
    expect(valueError('')).toBeNull()
    expect(valueError('   ')).toBeNull()
    expect(isSavable(draft(''))).toBe(true)
  })

  it('accepts ordinary prose, including markdown and quotes', () => {
    expect(valueError('Say "hello"; then run `mesa live listen`.')).toBeNull()
  })

  it('refuses a prompt past the byte bound the server enforces', () => {
    expect(valueError('x'.repeat(MAX_LIVE_PROMPT))).toBeNull()
    expect(valueError('x'.repeat(MAX_LIVE_PROMPT + 1))).toMatch(/limit/)
    // Measured in bytes, as the server measures it: a non-ASCII prompt that
    // fits by character count can still be over.
    expect(valueError('é'.repeat(MAX_LIVE_PROMPT))).toMatch(/limit/)
    expect(isSavable(draft('x'.repeat(MAX_LIVE_PROMPT + 1)))).toBe(false)
  })
})

describe('changedLive', () => {
  it('sends nothing when nothing changed', () => {
    expect(changedLive(SET, draftFrom(SET))).toEqual({})
    expect(changedLive(DEFAULTED, draftFrom(DEFAULTED))).toEqual({})
  })

  it('sends the trimmed prompt when it changed', () => {
    expect(changedLive(DEFAULTED, draft('  Be brief.  '))).toEqual({
      prompt: 'Be brief.',
    })
  })

  it('sends null when the box is cleared, restoring the built-in', () => {
    expect(changedLive(SET, draft('', '4500'))).toEqual({ prompt: null })
  })

  it('sends nothing while the draft would be rejected', () => {
    expect(changedLive(SET, draft('x'.repeat(MAX_LIVE_PROMPT + 1)))).toEqual({})
    expect(changedLive(SET, draft('Be brief.', '2.5'))).toEqual({})
  })

  it('sends the wait as a number, and only the box that changed', () => {
    expect(changedLive(SET, draft('Be brief.', '6000'))).toEqual({
      auto_send_ms: 6000,
    })
    expect(changedLive(DEFAULTED, draft('Hi.', '600'))).toEqual({
      prompt: 'Hi.',
      auto_send_ms: 600,
    })
  })

  it('sends null for a cleared wait, restoring the wait mesa ships', () => {
    expect(changedLive(SET, draft('Be brief.', ''))).toEqual({
      auto_send_ms: null,
    })
  })
})

describe('waitError', () => {
  it('accepts blank — that is the reset to the wait mesa ships', () => {
    expect(waitError('')).toBeNull()
    expect(waitError('  ')).toBeNull()
  })

  it('accepts a whole number of milliseconds inside the bounds', () => {
    expect(waitError(String(MIN_AUTO_SEND_MS))).toBeNull()
    expect(waitError('2000')).toBeNull()
    expect(waitError(String(MAX_AUTO_SEND_MS))).toBeNull()
  })

  it('refuses what the server would refuse', () => {
    expect(waitError('2.5')).toMatch(/whole number/)
    expect(waitError('1e3')).toMatch(/whole number/)
    expect(waitError('soon')).toMatch(/whole number/)
    expect(waitError(String(MIN_AUTO_SEND_MS - 1))).toMatch(/between/)
    expect(waitError(String(MAX_AUTO_SEND_MS + 1))).toMatch(/between/)
    expect(isSavable(draft('', '0'))).toBe(false)
  })

  it('counts a box the server would refuse as unsaved, not as stored', () => {
    expect(isDirty(SET, draft('Be brief.', 'soon'))).toBe(true)
  })
})
