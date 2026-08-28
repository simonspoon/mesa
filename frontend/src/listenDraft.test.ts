import { describe, expect, it } from 'vitest'
import {
  canPick,
  changedListen,
  draftFrom,
  isDirty,
  isSavable,
  options,
  valueError,
} from './listenDraft'
import type { ConfigListen } from './types/ConfigListen'

const MODELS = ['parakeet-tdt-0.6b-v2-int8', 'whisper-base', 'whisper-large-v3']
const DEFAULTED: ConfigListen = { model: null, models: MODELS }
const SET: ConfigListen = { model: 'whisper-base', models: MODELS }
/** What a machine with no `auris` installed reports. */
const NO_BINARY: ConfigListen = { model: 'whisper-base', models: [] }

describe('draftFrom', () => {
  it('renders an unconfigured model blank and a configured one as text', () => {
    expect(draftFrom(DEFAULTED)).toEqual({ model: '' })
    expect(draftFrom(SET)).toEqual({ model: 'whisper-base' })
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

  it('keeps the binary order and adds nothing when the model is listed', () => {
    expect(options(SET)).toEqual(MODELS)
    expect(options(DEFAULTED)).toEqual(MODELS)
  })

  it('keeps a configured model the binary no longer lists', () => {
    // Otherwise opening the list would silently rewrite a value nobody touched.
    const retired: ConfigListen = { model: 'am-gone', models: MODELS }
    expect(options(retired)).toEqual([...MODELS, 'am-gone'])
  })
})

describe('valueError', () => {
  it('accepts blank — that is the default, not a mistake', () => {
    expect(valueError('')).toBeNull()
    expect(valueError('   ')).toBeNull()
    expect(isSavable({ model: '' })).toBe(true)
  })

  it('accepts a model name, trimmed', () => {
    expect(valueError('whisper-base')).toBeNull()
    expect(valueError('  whisper-base  ')).toBeNull()
    expect(valueError('v2')).toBeNull()
  })

  it('accepts a dot — the real model names have version numbers in them', () => {
    expect(valueError('parakeet-tdt-0.6b-v2-int8')).toBeNull()
  })

  it('refuses a leading dot', () => {
    expect(valueError('.hidden')).not.toBeNull()
  })

  it('refuses anything that could reach the argv as an option', () => {
    expect(valueError('-o')).not.toBeNull()
    expect(valueError('--model x')).not.toBeNull()
    expect(valueError('whisper base')).not.toBeNull()
    expect(valueError('whisper/base')).not.toBeNull()
    expect(valueError('whisper-base; rm -rf /')).not.toBeNull()
    expect(valueError('a'.repeat(65))).not.toBeNull()
    expect(isSavable({ model: '-o' })).toBe(false)
  })
})

describe('changedListen', () => {
  it('sends nothing when nothing changed', () => {
    expect(changedListen(SET, draftFrom(SET))).toEqual({})
  })

  it('sends the new model, trimmed', () => {
    expect(changedListen(SET, { model: ' parakeet-tdt-0.6b-v2-int8 ' })).toEqual(
      { model: 'parakeet-tdt-0.6b-v2-int8' },
    )
  })

  it('sends null when the box is cleared — the reset', () => {
    expect(changedListen(SET, { model: '' })).toEqual({ model: null })
  })

  it('sends nothing the server would reject', () => {
    expect(changedListen(SET, { model: '-o' })).toEqual({})
  })
})
