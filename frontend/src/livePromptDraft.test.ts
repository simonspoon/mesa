import { describe, expect, it } from 'vitest'
import {
  MAX_LIVE_PROMPT,
  changedLive,
  draftFrom,
  isDirty,
  isSavable,
  usesDefault,
  valueError,
} from './livePromptDraft'
import type { ConfigLive } from './types/ConfigLive'

const BUILT_IN = 'You are the voice of mesa in a live conversation.'
const DEFAULTED: ConfigLive = { prompt: null, default_prompt: BUILT_IN }
const SET: ConfigLive = { prompt: 'Be brief.', default_prompt: BUILT_IN }

describe('draftFrom', () => {
  it('renders an unconfigured prompt blank and a configured one as text', () => {
    expect(draftFrom(DEFAULTED)).toEqual({ prompt: '' })
    expect(draftFrom(SET)).toEqual({ prompt: 'Be brief.' })
  })

  it('reports a freshly loaded section as pristine', () => {
    expect(isDirty(DEFAULTED, draftFrom(DEFAULTED))).toBe(false)
    expect(isDirty(SET, draftFrom(SET))).toBe(false)
  })
})

describe('usesDefault', () => {
  it('is true exactly while the box is blank', () => {
    expect(usesDefault({ prompt: '' })).toBe(true)
    expect(usesDefault({ prompt: '  ' })).toBe(true)
    expect(usesDefault({ prompt: 'Be brief.' })).toBe(false)
  })
})

describe('valueError', () => {
  it('accepts blank — that is the reset, not a mistake', () => {
    expect(valueError('')).toBeNull()
    expect(valueError('   ')).toBeNull()
    expect(isSavable({ prompt: '' })).toBe(true)
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
    expect(isSavable({ prompt: 'x'.repeat(MAX_LIVE_PROMPT + 1) })).toBe(false)
  })
})

describe('changedLive', () => {
  it('sends nothing when nothing changed', () => {
    expect(changedLive(SET, draftFrom(SET))).toEqual({})
    expect(changedLive(DEFAULTED, draftFrom(DEFAULTED))).toEqual({})
  })

  it('sends the trimmed prompt when it changed', () => {
    expect(changedLive(DEFAULTED, { prompt: '  Be brief.  ' })).toEqual({
      prompt: 'Be brief.',
    })
  })

  it('sends null when the box is cleared, restoring the built-in', () => {
    expect(changedLive(SET, { prompt: '' })).toEqual({ prompt: null })
  })

  it('sends nothing while the draft would be rejected', () => {
    expect(changedLive(SET, { prompt: 'x'.repeat(MAX_LIVE_PROMPT + 1) })).toEqual(
      {},
    )
  })
})
