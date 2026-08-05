import type { ConfigPrice } from './types/ConfigPrice'
import type { ModelRates } from './types/ModelRates'

/**
 * Pure draft logic for the Settings page's model-pricing editor, hoisted out
 * of the component so it is unit-testable (see CLAUDE.md: the frontend tests
 * cover the pure modules, never a rendered tree).
 *
 * Two things it models, both of which the server also draws:
 *
 * - **Blank means "use the built-in rate"**, exactly as a blank command box
 *   means "use the built-in template". A row whose four boxes are all blank is
 *   PUT as `null`, which restores the shipped rate for a family mesa knows and
 *   deletes the row for a prefix the user added.
 * - **A rate is edited as text, not as a number.** Half-typed input (`"0."`,
 *   `"-"`, `""`) has to survive a keystroke, so the draft holds strings and
 *   only `changedPricing` converts — parsing per render would clobber typing.
 */

/** The four rate fields, in the order the editor lays them out. */
export const RATE_FIELDS = [
  'input',
  'output',
  'cache_read',
  'cache_write',
] as const

export type RateField = (typeof RATE_FIELDS)[number]

/** One row's four boxes as typed. */
export type RateDraft = Record<RateField, string>

/** Per-prefix draft state, keyed exactly as the server keys the config. */
export type PricingDraft = Record<string, RateDraft>

const BLANK: RateDraft = {
  input: '',
  output: '',
  cache_read: '',
  cache_write: '',
}

/** A blank row — what "add model prefix" appends and what a reset restores. */
export function blankRates(): RateDraft {
  return { ...BLANK }
}

function textFor(value: ModelRates | null): RateDraft {
  if (!value) return blankRates()
  return {
    input: String(value.input),
    output: String(value.output),
    cache_read: String(value.cache_read),
    cache_write: String(value.cache_write),
  }
}

/** The editable text for each row as loaded: an unconfigured row is blank. */
export function draftFrom(prices: ConfigPrice[]): PricingDraft {
  const draft: PricingDraft = {}
  for (const p of prices) draft[p.prefix] = textFor(p.value)
  return draft
}

/** True when every box in a row is blank — the "no override" state. */
export function isBlank(row: RateDraft): boolean {
  return RATE_FIELDS.every((f) => (row[f] ?? '').trim() === '')
}

/**
 * The complaint about one rate box, or `null` if it is fine. Blank is only an
 * error when the *rest* of the row isn't — a wholly blank row is the reset,
 * not four mistakes.
 */
export function rateError(text: string): string | null {
  const trimmed = (text ?? '').trim()
  if (trimmed === '') return 'required'
  const n = Number(trimmed)
  if (!Number.isFinite(n)) return 'not a number'
  if (n < 0) return 'must be ≥ 0'
  return null
}

/** Mirrors `config::validate_prefix`, so the mistake is named as it is typed. */
export function prefixError(text: string): string | null {
  const trimmed = (text ?? '').trim()
  if (trimmed === '') return 'a model prefix is required'
  if (/\s/.test(trimmed)) return 'a model id has no whitespace'
  if ([...trimmed].length > 64) return 'longer than 64 characters'
  return null
}

/**
 * Every error in one drafted row — the prefix's, plus each rate's unless the
 * row is entirely blank (which is the legitimate "remove this override").
 */
export function rowErrors(prefix: string, row: RateDraft): string[] {
  const errors: string[] = []
  const bad = prefixError(prefix)
  if (bad) errors.push(bad)
  if (!isBlank(row)) {
    for (const f of RATE_FIELDS) {
      const e = rateError(row[f] ?? '')
      if (e) errors.push(`${f}: ${e}`)
    }
  }
  return errors
}

/** What a row's cost will actually be computed from: the draft, else the default. */
export function effectiveRates(
  price: ConfigPrice,
  draft: PricingDraft,
): ModelRates | null {
  const row = draft[price.prefix]
  if (!row || isBlank(row)) return price.default
  if (rowErrors(price.prefix, row).length > 0) return price.default
  return {
    input: Number(row.input),
    output: Number(row.output),
    cache_read: Number(row.cache_read),
    cache_write: Number(row.cache_write),
  }
}

function sameRates(a: ModelRates | null, b: ModelRates | null): boolean {
  if (!a || !b) return a === b
  return RATE_FIELDS.every((f) => a[f] === b[f])
}

/** True when this row's boxes differ from what the server last reported. */
export function isRowChanged(price: ConfigPrice, draft: PricingDraft): boolean {
  const row = draft[price.prefix]
  if (!row) return false
  if (isBlank(row)) return price.value !== null
  if (rowErrors(price.prefix, row).length > 0) return true
  return !sameRates(effectiveRatesRaw(row), price.value)
}

function effectiveRatesRaw(row: RateDraft): ModelRates {
  return {
    input: Number(row.input),
    output: Number(row.output),
    cache_read: Number(row.cache_read),
    cache_write: Number(row.cache_write),
  }
}

/**
 * The subset to PUT: only rows whose values actually changed. A row cleared to
 * blank sends `null` (the server's "remove this key"), which is the reset for
 * a built-in family and the delete for a user-added prefix.
 *
 * Rows the user never touched are left out, so the API's "only the keys
 * present are touched" rule keeps two editors from clobbering each other.
 */
export function changedPricing(
  prices: ConfigPrice[],
  draft: PricingDraft,
): Record<string, ModelRates | null> {
  const changed: Record<string, ModelRates | null> = {}
  for (const p of prices) {
    if (!isRowChanged(p, draft)) continue
    const row = draft[p.prefix]
    changed[p.prefix] = isBlank(row) ? null : effectiveRatesRaw(row)
  }
  return changed
}

/** True when anything is pending, i.e. the Save button does something. */
export function isDirty(prices: ConfigPrice[], draft: PricingDraft): boolean {
  return prices.some((p) => isRowChanged(p, draft))
}

/** True when nothing drafted would be rejected by the server. */
export function isSavable(prices: ConfigPrice[], draft: PricingDraft): boolean {
  return prices.every(
    (p) => rowErrors(p.prefix, draft[p.prefix] ?? blankRates()).length === 0,
  )
}

/**
 * A row the user is adding, whose prefix is still being typed. Held apart from
 * [`PricingDraft`] on purpose: the draft is keyed by prefix, and a key that
 * changes on every keystroke would need renaming mid-edit. Once saved, the
 * server echoes it back as an ordinary row and this one is dropped.
 */
export type NewRow = { prefix: string; rates: RateDraft }

/** An empty new row — what "add model prefix" appends. */
export function newRow(): NewRow {
  return { prefix: '', rates: blankRates() }
}

/** True for a new row the user has started filling in (so it must be saved). */
export function isNewRowStarted(row: NewRow): boolean {
  return row.prefix.trim() !== '' || !isBlank(row.rates)
}

/** Every complaint across the new rows, so the save button can stay disabled. */
export function newRowErrors(rows: NewRow[]): string[] {
  return rows
    .filter(isNewRowStarted)
    .flatMap((r) =>
      rowErrors(r.prefix, r.rates).concat(
        isBlank(r.rates) ? ['every rate is required on a new prefix'] : [],
      ),
    )
}

/** The new rows as PUT payload entries, keyed by their trimmed prefix. */
export function addedPricing(rows: NewRow[]): Record<string, ModelRates | null> {
  const added: Record<string, ModelRates | null> = {}
  for (const r of rows) {
    if (!isNewRowStarted(r) || newRowErrors([r]).length > 0) continue
    added[r.prefix.trim()] = effectiveRatesRaw(r.rates)
  }
  return added
}
