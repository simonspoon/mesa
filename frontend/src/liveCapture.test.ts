import { describe, expect, it } from 'vitest'
import {
  AUTO_SEND_IDLE_MS,
  GESTURE_WINDOW_MS,
  isEditableTarget,
  shouldAutoSend,
  shouldReclaimFocus,
  userTookFocus,
} from './liveCapture'

describe('isEditableTarget', () => {
  it('recognises the elements a person types into', () => {
    expect(isEditableTarget('INPUT', false)).toBe(true)
    expect(isEditableTarget('TEXTAREA', false)).toBe(true)
    expect(isEditableTarget('SELECT', false)).toBe(true)
    expect(isEditableTarget('DIV', true)).toBe(true)
  })

  it('buttons, links and nothing at all are not writing destinations', () => {
    expect(isEditableTarget('BUTTON', false)).toBe(false)
    expect(isEditableTarget('A', false)).toBe(false)
    expect(isEditableTarget(null, false)).toBe(false)
  })
})

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
  const armed = {
    live: true,
    unlocked: true,
    standingDown: false,
    listening: false,
  } as const

  it('never reclaims without a live session', () => {
    for (const cause of ['went-live', 'navigated', 'hub-press', 'focus-lost-no-gesture'] as const) {
      expect(shouldReclaimFocus({ ...armed, live: false, cause })).toBe(false)
    }
  })

  it('never reclaims before this browser has joined (no press)', () => {
    for (const cause of ['went-live', 'navigated', 'hub-press', 'focus-lost-no-gesture'] as const) {
      expect(shouldReclaimFocus({ ...armed, unlocked: false, cause })).toBe(false)
    }
  })

  it('reclaims on every cause while armed', () => {
    for (const cause of ['went-live', 'navigated', 'hub-press', 'focus-lost-no-gesture'] as const) {
      expect(shouldReclaimFocus({ ...armed, cause })).toBe(true)
    }
  })

  it('never reclaims while the browser is listening for itself', () => {
    for (const cause of ['went-live', 'navigated', 'hub-press', 'focus-lost-no-gesture'] as const) {
      expect(shouldReclaimFocus({ ...armed, listening: true, cause })).toBe(false)
    }
  })

  it('while standing down, only mesa acting again re-arms', () => {
    const down = { ...armed, standingDown: true }
    expect(shouldReclaimFocus({ ...down, cause: 'went-live' })).toBe(true)
    expect(shouldReclaimFocus({ ...down, cause: 'navigated' })).toBe(true)
    expect(shouldReclaimFocus({ ...down, cause: 'hub-press' })).toBe(true)
    expect(shouldReclaimFocus({ ...down, cause: 'focus-lost-no-gesture' })).toBe(false)
  })
})

describe('shouldAutoSend', () => {
  it('sends a settled non-empty draft', () => {
    expect(shouldAutoSend('make a task', AUTO_SEND_IDLE_MS, false, false)).toBe(true)
  })

  it('waits while the draft is still moving', () => {
    expect(shouldAutoSend('make a task', AUTO_SEND_IDLE_MS - 1, false, false)).toBe(false)
  })

  it('never sends blank or whitespace-only text', () => {
    expect(shouldAutoSend('', AUTO_SEND_IDLE_MS, false, false)).toBe(false)
    expect(shouldAutoSend('   \n', AUTO_SEND_IDLE_MS, false, false)).toBe(false)
  })

  it('never sends mid-IME-composition', () => {
    expect(shouldAutoSend('make a task', AUTO_SEND_IDLE_MS, true, false)).toBe(false)
  })

  it('never sends on a timer while the browser is listening for itself', () => {
    expect(shouldAutoSend('make a task', AUTO_SEND_IDLE_MS, false, true)).toBe(false)
  })
})
