import { describe, expect, it } from 'vitest'
import {
  addedPricing,
  blankRates,
  changedPricing,
  draftFrom,
  effectiveRates,
  isDirty,
  isNewRowStarted,
  isRowChanged,
  isSavable,
  newRowErrors,
  prefixError,
  rateError,
  type NewRow,
  type PricingDraft,
} from './pricingDraft'
import type { ConfigPrice } from './types/ConfigPrice'
import type { ModelRates } from './types/ModelRates'

const rates = (
  input: number,
  output: number,
  cache_read: number,
  cache_write: number,
): ModelRates => ({ input, output, cache_read, cache_write })

const OPUS: ConfigPrice = {
  prefix: 'claude-opus',
  value: null,
  default: rates(5, 25, 0.5, 6.25),
}
const ADDED: ConfigPrice = {
  prefix: 'newco',
  value: rates(1, 2, 3, 4),
  default: null,
}

function text(r: ModelRates) {
  return {
    input: String(r.input),
    output: String(r.output),
    cache_read: String(r.cache_read),
    cache_write: String(r.cache_write),
  }
}

describe('draftFrom', () => {
  it('renders an unconfigured row blank and a configured one as text', () => {
    const draft = draftFrom([OPUS, ADDED])
    expect(draft['claude-opus']).toEqual(blankRates())
    expect(draft['newco'].output).toBe('2')
  })

  it('reports a freshly loaded table as pristine', () => {
    const prices = [OPUS, ADDED]
    expect(isDirty(prices, draftFrom(prices))).toBe(false)
  })
})

describe('rateError', () => {
  it('accepts a finite number ≥ 0 and nothing else', () => {
    expect(rateError('0')).toBeNull()
    expect(rateError(' 6.25 ')).toBeNull()
    expect(rateError('')).toBe('required')
    expect(rateError('abc')).toBe('not a number')
    expect(rateError('-1')).toBe('must be ≥ 0')
    expect(rateError('Infinity')).toBe('not a number')
  })
})

describe('prefixError', () => {
  it('mirrors the server: non-empty, no whitespace, ≤ 64 chars', () => {
    expect(prefixError('claude-opus')).toBeNull()
    expect(prefixError('  ')).toBe('a model prefix is required')
    expect(prefixError('claude opus')).toBe('a model id has no whitespace')
    expect(prefixError('x'.repeat(64))).toBeNull()
    expect(prefixError('x'.repeat(65))).toBe('longer than 64 characters')
  })
})

describe('effectiveRates', () => {
  it('prefers the drafted override, falling back to the built-in', () => {
    const draft: PricingDraft = { 'claude-opus': blankRates() }
    expect(effectiveRates(OPUS, draft)).toEqual(OPUS.default)
    draft['claude-opus'] = text(rates(9, 9, 9, 9))
    expect(effectiveRates(OPUS, draft)).toEqual(rates(9, 9, 9, 9))
    // A half-typed row shows the default rather than a garbage number.
    draft['claude-opus'] = { ...blankRates(), input: '9' }
    expect(effectiveRates(OPUS, draft)).toEqual(OPUS.default)
  })

  it('is null for a user-added prefix cleared to blank', () => {
    expect(effectiveRates(ADDED, { newco: blankRates() })).toBeNull()
  })
})

describe('changedPricing', () => {
  it('sends only the rows that moved', () => {
    const prices = [OPUS, ADDED]
    const draft = draftFrom(prices)
    draft['claude-opus'] = text(rates(1, 1, 1, 1))
    expect(isRowChanged(OPUS, draft)).toBe(true)
    expect(isRowChanged(ADDED, draft)).toBe(false)
    expect(changedPricing(prices, draft)).toEqual({
      'claude-opus': rates(1, 1, 1, 1),
    })
  })

  it('sends null for a row cleared back to blank', () => {
    const prices = [OPUS, ADDED]
    const draft = draftFrom(prices)
    draft['newco'] = blankRates()
    expect(changedPricing(prices, draft)).toEqual({ newco: null })
    expect(isDirty(prices, draft)).toBe(true)
  })

  it('treats a re-typed identical value as no change', () => {
    const prices = [ADDED]
    const draft = { newco: text(rates(1, 2, 3, 4)) }
    expect(changedPricing(prices, draft)).toEqual({})
    // Trailing-zero spellings are the same number, not an edit.
    expect(changedPricing(prices, { newco: text(rates(1, 2, 3, 4)) })).toEqual({})
    expect(
      changedPricing(prices, {
        newco: { input: '1.0', output: '2', cache_read: '3', cache_write: '4' },
      }),
    ).toEqual({})
  })
})

describe('isSavable', () => {
  it('is false while a row is half-typed', () => {
    const draft: PricingDraft = {
      'claude-opus': { ...blankRates(), input: '-3' },
    }
    expect(isSavable([OPUS], draft)).toBe(false)
    expect(isSavable([OPUS], draftFrom([OPUS]))).toBe(true)
  })
})

describe('new rows', () => {
  const complete: NewRow = { prefix: 'newco-x', rates: text(rates(2, 4, 0, 0)) }

  it('ignores an untouched row entirely', () => {
    const empty: NewRow = { prefix: '', rates: blankRates() }
    expect(isNewRowStarted(empty)).toBe(false)
    expect(newRowErrors([empty])).toEqual([])
    expect(addedPricing([empty])).toEqual({})
  })

  it('sends a complete row keyed by its trimmed prefix', () => {
    expect(addedPricing([{ ...complete, prefix: '  newco-x  ' }])).toEqual({
      'newco-x': rates(2, 4, 0, 0),
    })
    expect(newRowErrors([complete])).toEqual([])
  })

  it('demands every rate once the row is started, and never sends a bad one', () => {
    const noRates: NewRow = { prefix: 'newco-x', rates: blankRates() }
    expect(newRowErrors([noRates])).toContain(
      'every rate is required on a new prefix',
    )
    expect(addedPricing([noRates])).toEqual({})
    const noPrefix: NewRow = { prefix: '', rates: text(rates(1, 1, 1, 1)) }
    expect(newRowErrors([noPrefix])).toContain('a model prefix is required')
    expect(addedPricing([noPrefix])).toEqual({})
  })
})
