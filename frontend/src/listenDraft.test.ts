import { describe, expect, it } from 'vitest'
import {
  canPick,
  changedListen,
  draftFrom,
  engineOptions,
  isDirty,
  isSavable,
  options,
  valueError,
} from './listenDraft'
import type { ConfigListen } from './types/ConfigListen'

const MODELS = ['parakeet-tdt-0.6b-v2-int8', 'whisper-base', 'whisper-large-v3']
const DEFAULTED: ConfigListen = { model: null, models: MODELS, engine: null, engine_default: 'server' }
const SET: ConfigListen = { model: 'whisper-base', models: MODELS, engine: null, engine_default: 'server' }
/** What a machine with no `auris` installed reports. */
const NO_BINARY: ConfigListen = { model: 'whisper-base', models: [], engine: null, engine_default: 'server' }

describe('draftFrom', () => {
  it('renders an unconfigured model blank and a configured one as text', () => {
    expect(draftFrom(DEFAULTED)).toEqual({ model: '', engine: 'server' })
    expect(draftFrom(SET)).toEqual({ model: 'whisper-base', engine: 'server' })
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
    const retired: ConfigListen = { model: 'am-gone', models: MODELS, engine: null, engine_default: 'server' }
    expect(options(retired)).toEqual([...MODELS, 'am-gone'])
  })
})

describe('valueError', () => {
  it('accepts blank — that is the default, not a mistake', () => {
    expect(valueError('')).toBeNull()
    expect(valueError('   ')).toBeNull()
    expect(isSavable({ model: '', engine: 'server' })).toBe(true)
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
    expect(isSavable({ model: '-o', engine: 'server' })).toBe(false)
  })
})

describe('changedListen', () => {
  it('sends nothing when nothing changed', () => {
    expect(changedListen(SET, draftFrom(SET))).toEqual({})
  })

  it('sends the new model, trimmed', () => {
    expect(changedListen(SET, { model: ' parakeet-tdt-0.6b-v2-int8 ', engine: 'server' })).toEqual(
      { model: 'parakeet-tdt-0.6b-v2-int8' },
    )
  })

  it('sends null when the box is cleared — the reset', () => {
    expect(changedListen(SET, { model: '', engine: 'server' })).toEqual({ model: null })
  })

  it('sends nothing the server would reject', () => {
    expect(changedListen(SET, { model: '-o', engine: 'server' })).toEqual({})
  })
})

describe('engine', () => {
  const BROWSER: ConfigListen = { ...SET, engine: 'browser' }

  it('drafts the engine in force and offers both, keeping a hand edit', () => {
    expect(draftFrom(BROWSER).engine).toBe('browser')
    expect(engineOptions(SET)).toEqual(['server', 'browser'])
    expect(engineOptions({ ...SET, engine: 'whisper' })).toEqual(['server', 'browser', 'whisper'])
    expect(isDirty(BROWSER, draftFrom(BROWSER))).toBe(false)
  })

  it('sends only the engine when only the engine changed', () => {
    const draft = { ...draftFrom(SET), engine: 'browser' }
    expect(isDirty(SET, draft)).toBe(true)
    expect(changedListen(SET, draft)).toEqual({ engine: 'browser' })
  })

  it('sends null to go back to the built-in engine', () => {
    expect(changedListen(BROWSER, { ...draftFrom(BROWSER), engine: 'server' })).toEqual({ engine: null })
  })

  it('sends both keys when both changed', () => {
    expect(changedListen(SET, { model: '', engine: 'browser' })).toEqual({ model: null, engine: 'browser' })
  })

  it('holds the engine back with a model the server would reject', () => {
    expect(changedListen(SET, { model: '-o', engine: 'browser' })).toEqual({})
  })
})
