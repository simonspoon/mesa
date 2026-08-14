import { describe, expect, it } from 'vitest'
import {
  AUTO_SEND_IDLE_MS,
  GESTURE_WINDOW_MS,
  shouldAutoSend,
  shouldReclaimFocus,
  userTookFocus,
} from './liveCapture'

describe('userTookFocus', () => {
  it('is false when no gesture was ever seen', () => {
    expect(userTookFocus(null, 1000)).toBe(false)
  })

  it('is true for a focus loss right after a gesture', () => {
    expect(userTookFocus(1000, 1000)).toBe(true)
    expect(userTookFocus(1000, 1000 + GESTURE_WINDOW_MS)).toBe(true)
  })

  it('is false once the gesture is stale', () => {
    expect(userTookFocus(1000, 1001 + GESTURE_WINDOW_MS)).toBe(false)
  })
})

describe('shouldReclaimFocus', () => {
  const armed = { live: true, unlocked: true, standingDown: false } as const

  it('never reclaims without a live session', () => {
    for (const cause of ['went-live', 'navigated', 'focus-lost-no-gesture'] as const) {
      expect(shouldReclaimFocus({ ...armed, live: false, cause })).toBe(false)
    }
  })

  it('never reclaims before this browser has joined (no press)', () => {
    for (const cause of ['went-live', 'navigated', 'focus-lost-no-gesture'] as const) {
      expect(shouldReclaimFocus({ ...armed, unlocked: false, cause })).toBe(false)
    }
  })

  it('reclaims on every cause while armed', () => {
    for (const cause of ['went-live', 'navigated', 'focus-lost-no-gesture'] as const) {
      expect(shouldReclaimFocus({ ...armed, cause })).toBe(true)
    }
  })

  it('while standing down, only mesa acting again re-arms', () => {
    const down = { ...armed, standingDown: true }
    expect(shouldReclaimFocus({ ...down, cause: 'went-live' })).toBe(true)
    expect(shouldReclaimFocus({ ...down, cause: 'navigated' })).toBe(true)
    expect(shouldReclaimFocus({ ...down, cause: 'focus-lost-no-gesture' })).toBe(false)
  })
})

describe('shouldAutoSend', () => {
  it('sends a settled non-empty draft', () => {
    expect(shouldAutoSend('make a task', AUTO_SEND_IDLE_MS, false)).toBe(true)
  })

  it('waits while the draft is still moving', () => {
    expect(shouldAutoSend('make a task', AUTO_SEND_IDLE_MS - 1, false)).toBe(false)
  })

  it('never sends blank or whitespace-only text', () => {
    expect(shouldAutoSend('', AUTO_SEND_IDLE_MS, false)).toBe(false)
    expect(shouldAutoSend('   \n', AUTO_SEND_IDLE_MS, false)).toBe(false)
  })

  it('never sends mid-IME-composition', () => {
    expect(shouldAutoSend('make a task', AUTO_SEND_IDLE_MS, true)).toBe(false)
  })
})
