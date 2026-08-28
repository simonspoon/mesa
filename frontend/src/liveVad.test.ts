import { describe, expect, it } from 'vitest'
import { DEFAULT_VAD, initialVad, vadCut, vadStep, type VadConfig, type VadState } from './liveVad'

const config: VadConfig = DEFAULT_VAD

describe('vadStep', () => {
  it('stays silent and unchanged while quiet', () => {
    const state = initialVad()
    const step = vadStep(state, { rms: 0, at: 0 }, config)
    expect(step.loud).toBe(false)
    expect(step.ended).toBeNull()
    expect(step.state).toEqual(initialVad())
  })

  it('starts an utterance on a loud frame', () => {
    const step = vadStep(initialVad(), { rms: 0.05, at: 1000 }, config)
    expect(step.loud).toBe(true)
    expect(step.ended).toBeNull()
    expect(step.state).toEqual({ startedAt: 1000, lastLoudAt: 1000 })
  })

  it('hysteresis: a level between release and onset keeps a running utterance going but never starts one', () => {
    const midLevel = (config.onsetRms + config.releaseRms) / 2
    // Does not start from silence.
    const notStarted = vadStep(initialVad(), { rms: midLevel, at: 0 }, config)
    expect(notStarted.loud).toBe(false)
    expect(notStarted.state.startedAt).toBeNull()

    // But keeps a running utterance going.
    const speaking: VadState = { startedAt: 0, lastLoudAt: 0 }
    const kept = vadStep(speaking, { rms: midLevel, at: 100 }, config)
    expect(kept.loud).toBe(true)
    expect(kept.state).toEqual({ startedAt: 0, lastLoudAt: 100 })
    expect(kept.ended).toBeNull()
  })

  it('ends a full utterance after the hangover, with the right startedAt/endedAt', () => {
    let state = initialVad()
    state = vadStep(state, { rms: 0.05, at: 0 }, config).state // start
    state = vadStep(state, { rms: 0.05, at: 300 }, config).state // still loud
    const lastLoud = 300
    const quiet1 = vadStep(state, { rms: 0, at: 500 }, config)
    expect(quiet1.ended).toBeNull() // inside hangover (500 - 300 = 200 < 700)
    state = quiet1.state
    const ended = vadStep(state, { rms: 0, at: lastLoud + config.hangoverMs }, config)
    expect(ended.loud).toBe(false)
    expect(ended.ended).toEqual({ startedAt: 0, endedAt: lastLoud })
    expect(ended.state).toEqual(initialVad())
  })

  it('discards a too-short blip, producing no ended but resetting', () => {
    const state: VadState = { startedAt: 0, lastLoudAt: 0 } // speaking briefly
    // Silence arrives before minSpeechMs (200) has elapsed.
    const step = vadStep(state, { rms: 0, at: config.hangoverMs + 50 }, config)
    expect(step.ended).toBeNull()
    expect(step.state).toEqual(initialVad())
  })

  it('cuts at maxSegmentMs, producing an ended segment and a state still speaking', () => {
    const speaking: VadState = { startedAt: 0, lastLoudAt: 0 }
    const step = vadStep(speaking, { rms: 0.05, at: config.maxSegmentMs }, config)
    expect(step.loud).toBe(true)
    expect(step.ended).toEqual({ startedAt: 0, endedAt: config.maxSegmentMs })
    expect(step.state).toEqual({ startedAt: config.maxSegmentMs, lastLoudAt: config.maxSegmentMs })
  })

  it('produces nothing on continued silence', () => {
    const step = vadStep(initialVad(), { rms: 0, at: 5000 }, config)
    expect(step.loud).toBe(false)
    expect(step.ended).toBeNull()
    expect(step.state).toEqual(initialVad())
  })

  it('never mutates the state object it was given', () => {
    const state: VadState = { startedAt: 0, lastLoudAt: 0 }
    const frozen = { ...state }
    vadStep(state, { rms: 0.05, at: 100 }, config)
    expect(state).toEqual(frozen)

    const silent = initialVad()
    const frozenSilent = { ...silent }
    vadStep(silent, { rms: 0, at: 100 }, config)
    expect(silent).toEqual(frozenSilent)
  })
})

describe('vadCut', () => {
  it('is null with no utterance in progress', () => {
    expect(vadCut(initialVad(), config)).toBeNull()
  })

  it('is null for an utterance shorter than minSpeechMs', () => {
    const state: VadState = { startedAt: 0, lastLoudAt: config.minSpeechMs - 1 }
    expect(vadCut(state, config)).toBeNull()
  })

  it('cuts an in-progress utterance at lastLoudAt, not now', () => {
    const state: VadState = { startedAt: 0, lastLoudAt: config.minSpeechMs + 50 }
    expect(vadCut(state, config)).toEqual({ startedAt: 0, endedAt: config.minSpeechMs + 50 })
  })

  it('honours a custom config', () => {
    const custom: VadConfig = { ...config, minSpeechMs: 1000 }
    const tooShort: VadState = { startedAt: 0, lastLoudAt: 999 }
    expect(vadCut(tooShort, custom)).toBeNull()
    const longEnough: VadState = { startedAt: 0, lastLoudAt: 1000 }
    expect(vadCut(longEnough, custom)).toEqual({ startedAt: 0, endedAt: 1000 })
  })
})
