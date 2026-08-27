import { describe, expect, it } from 'vitest'
import {
  MAX_AUTO_SEND_MS,
  MIN_AUTO_SEND_MS,
  changedLive,
  draftFrom,
  isDirty,
  isSavable,
  waitError,
} from './livePromptDraft'
import type { ConfigLive } from './types/ConfigLive'

const DEFAULTED: ConfigLive = {
  auto_send_ms: null,
  auto_send_ms_default: 2000,
}
const SET: ConfigLive = {
  auto_send_ms: 4500,
  auto_send_ms_default: 2000,
}

/** A draft holding the one box, so a test names only the one it is about. */
const draft = (auto_send_ms = '') => ({ auto_send_ms })

describe('draftFrom', () => {
  it('renders an unconfigured wait blank and a configured one as text', () => {
    expect(draftFrom(DEFAULTED)).toEqual({ auto_send_ms: '' })
    expect(draftFrom(SET)).toEqual({ auto_send_ms: '4500' })
  })

  it('reports a freshly loaded section as pristine', () => {
    expect(isDirty(DEFAULTED, draftFrom(DEFAULTED))).toBe(false)
    expect(isDirty(SET, draftFrom(SET))).toBe(false)
  })
})

describe('changedLive', () => {
  it('sends nothing when nothing changed', () => {
    expect(changedLive(SET, draftFrom(SET))).toEqual({})
    expect(changedLive(DEFAULTED, draftFrom(DEFAULTED))).toEqual({})
  })

  it('sends nothing while the draft would be rejected', () => {
    expect(changedLive(SET, draft('2.5'))).toEqual({})
  })

  it('sends the wait as a number when it changed', () => {
    expect(changedLive(SET, draft('6000'))).toEqual({
      auto_send_ms: 6000,
    })
    expect(changedLive(DEFAULTED, draft('600'))).toEqual({
      auto_send_ms: 600,
    })
  })

  it('sends null for a cleared wait, restoring the wait mesa ships', () => {
    expect(changedLive(SET, draft(''))).toEqual({
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
    expect(isSavable(draft('0'))).toBe(false)
  })

  it('counts a box the server would refuse as unsaved, not as stored', () => {
    expect(isDirty(SET, draft('soon'))).toBe(true)
  })
})
