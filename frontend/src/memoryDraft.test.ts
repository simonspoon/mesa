import { describe, expect, it } from 'vitest'
import {
  NOTEBOOK_BUDGET_WORDS,
  NOTEBOOK_ENTRY_MAX,
  bodyError,
  budgetMeter,
  isSendable,
  metaLine,
  notebookWords,
  overBudget,
  wordCount,
} from './memoryDraft'
import type { LiveNotebookEntry } from './types/LiveNotebookEntry'

function entry(over: Partial<LiveNotebookEntry> = {}): LiveNotebookEntry {
  return {
    id: 3,
    body: 'Prefers short spoken replies.',
    created_at: '2026-09-01 10:00:00',
    updated_at: '2026-09-01 10:00:00',
    source_session_id: 12,
    last_used_session_id: 15,
    retired_at: null,
    retired_reason: null,
    merged_into: null,
    project_id: null,
    last_used_at: null,
    ...over,
  }
}

describe('wordCount', () => {
  it('counts whitespace-separated tokens, like core::live::word_count', () => {
    expect(wordCount('')).toBe(0)
    expect(wordCount('   ')).toBe(0)
    expect(wordCount('one')).toBe(1)
    expect(wordCount('  two\twords\n here ')).toBe(3)
    expect(wordCount("don't hyphen-ate, punctuation!")).toBe(3)
  })
})

describe('notebookWords / budgetMeter / overBudget', () => {
  it('sums the active entries and renders the meter', () => {
    const entries = [entry({ body: 'one two' }), entry({ id: 4, body: 'three' })]
    expect(notebookWords(entries)).toBe(3)
    expect(budgetMeter(3)).toBe(`3 / ${NOTEBOOK_BUDGET_WORDS} words`)
    expect(notebookWords([])).toBe(0)
  })

  it('is strict at the budget, like the server', () => {
    expect(overBudget(NOTEBOOK_BUDGET_WORDS)).toBe(false)
    expect(overBudget(NOTEBOOK_BUDGET_WORDS + 1)).toBe(true)
  })
})

describe('metaLine', () => {
  it('names the id, the date and both sessions', () => {
    expect(metaLine(entry())).toBe(
      '#3 · added 2026-09-01 · from session 12 · last used session 15',
    )
  })

  it('prints a dash for a missing session rather than inventing one', () => {
    expect(
      metaLine(entry({ source_session_id: null, last_used_session_id: null })),
    ).toBe('#3 · added 2026-09-01 · from session - · last used session -')
  })
})

describe('isSendable / bodyError', () => {
  it('refuses blank and over-long, accepts the bound', () => {
    expect(isSendable('')).toBe(false)
    expect(isSendable('   ')).toBe(false)
    expect(isSendable('a bullet')).toBe(true)
    expect(isSendable('x'.repeat(NOTEBOOK_ENTRY_MAX))).toBe(true)
    expect(isSendable('x'.repeat(NOTEBOOK_ENTRY_MAX + 1))).toBe(false)
  })

  it('complains only about length — blank is not an error while typing', () => {
    expect(bodyError('')).toBeNull()
    expect(bodyError('fine')).toBeNull()
    expect(bodyError('x'.repeat(NOTEBOOK_ENTRY_MAX + 1))).toContain('600')
  })
})
