import { describe, expect, it } from 'vitest'
import {
  AUTO_SEND_IDLE_MS,
  autoSendIdleMs,
  GESTURE_WINDOW_MS,
  MAX_AUTO_SEND_IDLE_MS,
  MIN_AUTO_SEND_IDLE_MS,
  isEditableTarget,
  shouldAutoSend,
  shouldReclaimFocus,
  userTookFocus,
} from './liveCapture'
import type { ConfigLive } from './types/ConfigLive'

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
  const D = AUTO_SEND_IDLE_MS

  it('sends a settled non-empty draft', () => {
    expect(shouldAutoSend('make a task', D, false, false, D)).toBe(true)
  })

  it('waits while the draft is still moving', () => {
    expect(shouldAutoSend('make a task', D - 1, false, false, D)).toBe(false)
  })

  it('never sends blank or whitespace-only text', () => {
    expect(shouldAutoSend('', D, false, false, D)).toBe(false)
    expect(shouldAutoSend('   \n', D, false, false, D)).toBe(false)
  })

  it('never sends mid-IME-composition', () => {
    expect(shouldAutoSend('make a task', D, true, false, D)).toBe(false)
  })

  it('never sends on a timer while the browser is listening for itself', () => {
    expect(shouldAutoSend('make a task', D, false, true, D)).toBe(false)
  })

  it('measures the idle draft against the configured wait, not the built-in one', () => {
    // A person who set a longer wait is still mid-sentence at two seconds…
    expect(shouldAutoSend('make a task', D, false, false, 6000)).toBe(false)
    expect(shouldAutoSend('make a task', 6000, false, false, 6000)).toBe(true)
    // …and one who set a shorter wait has finished before them.
    expect(shouldAutoSend('make a task', 500, false, false, 500)).toBe(true)
  })
})

describe('autoSendIdleMs', () => {
  const live = (auto_send_ms: number | null): ConfigLive => ({
    prompt: null,
    default_prompt: '',
    auto_send_ms,
    auto_send_ms_default: AUTO_SEND_IDLE_MS,
  })

  it('is the built-in wait before the config has been read', () => {
    expect(autoSendIdleMs(null)).toBe(AUTO_SEND_IDLE_MS)
  })

  it('is the built-in wait when the config says nothing', () => {
    expect(autoSendIdleMs(live(null))).toBe(AUTO_SEND_IDLE_MS)
  })

  it('is the configured wait when there is one', () => {
    expect(autoSendIdleMs(live(4500))).toBe(4500)
  })

  it('clamps a hand-edited value into the bounds the editor writes', () => {
    expect(autoSendIdleMs(live(0))).toBe(MIN_AUTO_SEND_IDLE_MS)
    expect(autoSendIdleMs(live(999999))).toBe(MAX_AUTO_SEND_IDLE_MS)
  })
})
