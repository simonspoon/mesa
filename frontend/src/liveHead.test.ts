import { describe, expect, it } from 'vitest'
import {
  elapsedLabel,
  emptyMeterHistory,
  endsInHead,
  liveHeadTitle,
  METER_BARS,
  METER_FRAMES_PER_BAR,
  pushMeterHistory,
} from './liveHead'
import type { LiveButton } from './liveSession'

function input(patch: Partial<Parameters<typeof liveHeadTitle>[0]> = {}) {
  return {
    live: true,
    speaking: false,
    paused: false,
    interim: '',
    draft: '',
    error: null,
    ...patch,
  }
}

describe('liveHeadTitle', () => {
  it('rests on Live while the conversation is simply running', () => {
    expect(liveHeadTitle(input())).toBe('Live')
  })

  it('reports being heard, by either route in', () => {
    expect(liveHeadTitle(input({ interim: 'the quick brown' }))).toBe('Hearing you')
    expect(liveHeadTitle(input({ draft: 'typed at it' }))).toBe('Hearing you')
    // Whitespace is not speech — `headerIndicator`'s rule, unchanged.
    expect(liveHeadTitle(input({ interim: '  ', draft: '\n' }))).toBe('Live')
  })

  it('lets mesa speaking outrank the person, and paused outrank a stale draft', () => {
    expect(liveHeadTitle(input({ speaking: true, draft: 'over her' }))).toBe(
      'mesa speaking',
    )
    expect(liveHeadTitle(input({ speaking: true, paused: true }))).toBe('mesa speaking')
    expect(liveHeadTitle(input({ paused: true, draft: 'left in the box' }))).toBe(
      'Paused',
    )
  })

  it('puts the session itself above anything happening inside it', () => {
    expect(liveHeadTitle(input({ live: false }))).toBe('Disconnected')
    expect(liveHeadTitle(input({ live: false, paused: true }))).toBe('Disconnected')
    // A tail of audio outliving the conversation still says the session is gone:
    // unlike the aperture, this line is about the conversation, not the sound.
    expect(liveHeadTitle(input({ live: false, speaking: true }))).toBe('Disconnected')
  })

  it('lets a failure outrank everything', () => {
    expect(liveHeadTitle(input({ error: 'fetch failed' }))).toBe('Reconnecting')
    expect(liveHeadTitle(input({ error: 'fetch failed', live: false }))).toBe(
      'Reconnecting',
    )
    expect(liveHeadTitle(input({ error: 'fetch failed', speaking: true }))).toBe(
      'Reconnecting',
    )
  })
})

describe('elapsedLabel', () => {
  it('zero-pads both halves', () => {
    expect(elapsedLabel(0, 0)).toBe('00:00')
    expect(elapsedLabel(0, 9_000)).toBe('00:09')
    expect(elapsedLabel(0, 61_000)).toBe('01:01')
  })

  it('rolls hours into minutes rather than growing a third field', () => {
    expect(elapsedLabel(0, 3_661_000)).toBe('61:01')
  })

  it('floors, and clamps a clock-skewed future start at zero', () => {
    expect(elapsedLabel(0, 1_999)).toBe('00:01')
    expect(elapsedLabel(10_000, 0)).toBe('00:00')
  })
})

describe('pushMeterHistory', () => {
  it('returns the same array on the frames between bars', () => {
    const history = emptyMeterHistory()
    for (let tick = 1; tick < METER_FRAMES_PER_BAR; tick += 1) {
      expect(pushMeterHistory(history, 0.5, tick)).toBe(history)
    }
  })

  it('scrolls one bar in on the right and one off the left', () => {
    let history = emptyMeterHistory()
    history = pushMeterHistory(history, 0.25, 0)
    history = pushMeterHistory(history, 0.5, METER_FRAMES_PER_BAR)
    expect(history).toHaveLength(METER_BARS)
    expect(history.slice(-2)).toEqual([0.25, 0.5])
    expect(history[0]).toBe(0)
  })

  it('keeps its length whatever it is handed, and clamps the level', () => {
    expect(pushMeterHistory([], 0.5, 0)).toHaveLength(METER_BARS)
    expect(pushMeterHistory([], 4, 0).at(-1)).toBe(1)
    expect(pushMeterHistory([], -1, 0).at(-1)).toBe(0)
  })

  it('drops the oldest once the row is full', () => {
    let history = emptyMeterHistory()
    for (let bar = 1; bar <= METER_BARS; bar += 1) {
      history = pushMeterHistory(history, bar / 100, bar * METER_FRAMES_PER_BAR)
    }
    expect(history[0]).toBe(0.01)
    history = pushMeterHistory(history, 0.99, (METER_BARS + 1) * METER_FRAMES_PER_BAR)
    expect(history[0]).toBe(0.02)
    expect(history.at(-1)).toBe(0.99)
  })
})

describe('endsInHead', () => {
  const end: LiveButton = { label: 'End', action: 'stop', disabled: false }

  it('takes a real End into the panel head', () => {
    expect(endsInHead(end)).toBe(true)
  })

  it('leaves the header its own presses, and its in-flight feedback', () => {
    expect(endsInHead(null)).toBe(false)
    expect(endsInHead({ label: 'Go live', action: 'start', disabled: false })).toBe(false)
    expect(endsInHead({ label: 'Listen', action: 'listen', disabled: false })).toBe(false)
    // `Going live…` is labelled `stop` while the spawn runs: it stays in the
    // header, which is where the person pressed and is still looking.
    expect(endsInHead({ label: 'Going live…', action: 'stop', disabled: true })).toBe(
      false,
    )
  })
})
