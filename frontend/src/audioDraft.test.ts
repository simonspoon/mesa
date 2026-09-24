import { describe, expect, it } from 'vitest'
import {
  changedAudio,
  draftFrom,
  engineChange,
  engineChoices,
  isDirty,
  options,
  probeLine,
} from './audioDraft'
import type { ConfigAudio } from './types/ConfigAudio'

const base = { url: null, url_default: 'http://127.0.0.1:7870', engine_default: 'legacy' }
const UNSET: ConfigAudio = { ...base, engine: null }
const DAEMON: ConfigAudio = { ...base, engine: 'naru-audio' }
const EXPLICIT_LEGACY: ConfigAudio = { ...base, engine: 'legacy' }
/** A hand edit the server would refuse to save. */
const HAND_EDITED: ConfigAudio = { ...base, engine: 'whisper' }

describe('draftFrom', () => {
  it('shows the engine in force: the configured one, else the built-in', () => {
    expect(draftFrom(UNSET)).toEqual({ engine: 'legacy' })
    expect(draftFrom(DAEMON)).toEqual({ engine: 'naru-audio' })
    expect(draftFrom({ ...base, engine: '  ' })).toEqual({ engine: 'legacy' })
  })

  it('reports a freshly loaded section as pristine', () => {
    for (const audio of [UNSET, DAEMON, EXPLICIT_LEGACY, HAND_EDITED]) {
      expect(isDirty(audio, draftFrom(audio))).toBe(false)
      expect(changedAudio(audio, draftFrom(audio))).toEqual({})
    }
  })
})

describe('options', () => {
  it('offers both engines, built-in first', () => {
    expect(options(UNSET)).toEqual(['legacy', 'naru-audio'])
    expect(options(DAEMON)).toEqual(['legacy', 'naru-audio'])
  })

  it('keeps a hand-edited value so the select does not rewrite it', () => {
    expect(options(HAND_EDITED)).toEqual(['legacy', 'naru-audio', 'whisper'])
    expect(engineChoices(null, ['a', 'b'])).toEqual(['a', 'b'])
  })
})

describe('changedAudio', () => {
  it('sends the daemon engine when picked', () => {
    expect(isDirty(UNSET, { engine: 'naru-audio' })).toBe(true)
    expect(changedAudio(UNSET, { engine: 'naru-audio' })).toEqual({ engine: 'naru-audio' })
  })

  it('sends null to go back to the built-in — the route removes the key', () => {
    expect(changedAudio(DAEMON, { engine: 'legacy' })).toEqual({ engine: null })
    expect(changedAudio(HAND_EDITED, { engine: 'legacy' })).toEqual({ engine: null })
  })

  it('sends nothing when an explicit built-in is picked again', () => {
    expect(changedAudio(EXPLICIT_LEGACY, { engine: 'legacy' })).toEqual({})
  })

  it('never sends a url', () => {
    const withUrl: ConfigAudio = { ...DAEMON, url: 'http://127.0.0.1:9999' }
    expect(changedAudio(withUrl, { engine: 'legacy' })).toEqual({ engine: null })
  })
})

describe('engineChange', () => {
  it('is undefined for the engine in force, null for the built-in, else the engine', () => {
    expect(engineChange(null, 'server', 'server')).toBeUndefined()
    expect(engineChange('browser', 'server', 'browser')).toBeUndefined()
    expect(engineChange('browser', 'server', 'server')).toBeNull()
    expect(engineChange(null, 'server', 'browser')).toBe('browser')
  })
})

describe('probeLine', () => {
  it('names the engine, the state in words and when it was checked', () => {
    expect(
      probeLine({
        available: true,
        state: 'ready',
        engine: 'legacy',
        url: null,
        message: null,
        checked_at: '2026-09-24T12:00:03Z',
      }),
    ).toBe('legacy: ready (checked 2026-09-24T12:00:03Z)')
  })

  it('names the daemon URL on naru-audio', () => {
    expect(
      probeLine({
        available: false,
        state: 'daemon_down',
        engine: 'naru-audio',
        url: 'http://127.0.0.1:7870',
        message: "Speech isn't available",
        checked_at: '2026-09-24T12:00:03Z',
      }),
    ).toBe('naru-audio at http://127.0.0.1:7870: daemon down (checked 2026-09-24T12:00:03Z)')
  })
})
