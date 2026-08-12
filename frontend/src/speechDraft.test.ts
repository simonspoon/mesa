import { describe, expect, it } from 'vitest'
import {
  canPick,
  changedSpeech,
  draftFrom,
  isDirty,
  isSavable,
  options,
  valueError,
} from './speechDraft'
import type { ConfigSpeech } from './types/ConfigSpeech'

const VOICES = ['af_heart', 'bm_george', 'zf_xiaoni']
const DEFAULTED: ConfigSpeech = { voice: null, voices: VOICES }
const SET: ConfigSpeech = { voice: 'bm_george', voices: VOICES }
/** What a machine with no synthesiser installed reports. */
const NO_BINARY: ConfigSpeech = { voice: 'bm_george', voices: [] }

describe('draftFrom', () => {
  it('renders an unconfigured voice blank and a configured one as text', () => {
    expect(draftFrom(DEFAULTED)).toEqual({ voice: '' })
    expect(draftFrom(SET)).toEqual({ voice: 'bm_george' })
  })

  it('reports a freshly loaded section as pristine', () => {
    expect(isDirty(DEFAULTED, draftFrom(DEFAULTED))).toBe(false)
    expect(isDirty(SET, draftFrom(SET))).toBe(false)
  })
})

describe('options', () => {
  it('offers a list only when the binary answered', () => {
    expect(canPick(DEFAULTED)).toBe(true)
    expect(canPick(NO_BINARY)).toBe(false)
  })

  it('keeps the binary order and adds nothing when the voice is listed', () => {
    expect(options(SET)).toEqual(VOICES)
    expect(options(DEFAULTED)).toEqual(VOICES)
  })

  it('keeps a configured voice the binary no longer lists', () => {
    // Otherwise opening the list would silently rewrite a value nobody touched.
    const retired: ConfigSpeech = { voice: 'am_gone', voices: VOICES }
    expect(options(retired)).toEqual([...VOICES, 'am_gone'])
  })
})

describe('valueError', () => {
  it('accepts blank — that is the default, not a mistake', () => {
    expect(valueError('')).toBeNull()
    expect(valueError('   ')).toBeNull()
    expect(isSavable({ voice: '' })).toBe(true)
  })

  it('accepts a voice name, trimmed', () => {
    expect(valueError('af_heart')).toBeNull()
    expect(valueError('  bm_george  ')).toBeNull()
    expect(valueError('v2')).toBeNull()
  })

  it('refuses anything that could reach the argv as an option', () => {
    expect(valueError('-o')).not.toBeNull()
    expect(valueError('--voice x')).not.toBeNull()
    expect(valueError('af heart')).not.toBeNull()
    expect(valueError('af_heart; rm -rf /')).not.toBeNull()
    expect(valueError('a'.repeat(65))).not.toBeNull()
    expect(isSavable({ voice: '-o' })).toBe(false)
  })
})

describe('changedSpeech', () => {
  it('sends nothing when nothing changed', () => {
    expect(changedSpeech(SET, draftFrom(SET))).toEqual({})
  })

  it('sends the new voice, trimmed', () => {
    expect(changedSpeech(SET, { voice: ' af_heart ' })).toEqual({
      voice: 'af_heart',
    })
  })

  it('sends null when the box is cleared — the reset', () => {
    expect(changedSpeech(SET, { voice: '' })).toEqual({ voice: null })
  })

  it('sends nothing the server would reject', () => {
    expect(changedSpeech(SET, { voice: '-o' })).toEqual({})
  })
})
