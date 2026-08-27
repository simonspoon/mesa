import { describe, expect, it } from 'vitest'
import {
  defaultChoice,
  isOneSided,
  needsAttention,
  resolutionsFor,
  resultLabel,
  rowKey,
  statusExplains,
  statusLabel,
  summarize,
} from './librarySync'
import type { LibrarySyncResult } from './types/LibrarySyncResult'
import type { LibrarySyncRow } from './types/LibrarySyncRow'
import type { LibrarySyncStatus } from './types/LibrarySyncStatus'

const ALL_STATUSES: LibrarySyncStatus[] = [
  'in-sync',
  'mesa-new',
  'disk-deleted',
  'mesa-changed',
  'disk-changed',
  'both-changed',
  'disk-new',
]

function row(overrides: Partial<LibrarySyncRow> = {}): LibrarySyncRow {
  return {
    item_id: 1,
    builtin_id: null,
    name: 'my-agent',
    kind: 'agent',
    scope: 'user',
    project_id: null,
    path: '.claude/agents/my-agent.md',
    status: 'in-sync',
    mesa_body: 'same',
    disk_body: 'same',
    baseline: 'same',
    ...overrides,
  }
}

describe('statusLabel', () => {
  it('gives every status a distinct, non-empty label', () => {
    const labels = ALL_STATUSES.map(statusLabel)
    expect(labels.every((l) => l.length > 0)).toBe(true)
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe('statusExplains', () => {
  it('gives every status a distinct, non-empty sentence', () => {
    const sentences = ALL_STATUSES.map(statusExplains)
    expect(sentences.every((s) => s.length > 0)).toBe(true)
    expect(new Set(sentences).size).toBe(sentences.length)
  })

  it('mentions both sides for every one-sided or conflicting status', () => {
    for (const status of ALL_STATUSES) {
      if (status === 'in-sync') continue
      const text = statusExplains(status).toLowerCase()
      expect(text).toContain('mesa')
      expect(text).toContain('disk')
    }
  })
})

describe('isOneSided', () => {
  it('is true for exactly the four one-sided statuses', () => {
    const oneSided = ALL_STATUSES.filter((status) => isOneSided(row({ status })))
    expect(oneSided.sort()).toEqual(
      ['mesa-new', 'disk-deleted', 'mesa-changed', 'disk-changed'].sort(),
    )
  })

  it('is false for in-sync, both-changed and disk-new', () => {
    expect(isOneSided(row({ status: 'in-sync' }))).toBe(false)
    expect(isOneSided(row({ status: 'both-changed' }))).toBe(false)
    expect(isOneSided(row({ status: 'disk-new' }))).toBe(false)
  })
})

describe('needsAttention', () => {
  it('is false only for in-sync', () => {
    for (const status of ALL_STATUSES) {
      expect(needsAttention(row({ status }))).toBe(status !== 'in-sync')
    }
  })
})

describe('defaultChoice', () => {
  it('pre-selects the side that changed for each one-sided status', () => {
    expect(defaultChoice(row({ status: 'mesa-new' }))).toBe('mesa')
    expect(defaultChoice(row({ status: 'mesa-changed' }))).toBe('mesa')
    expect(defaultChoice(row({ status: 'disk-deleted' }))).toBe('disk')
    expect(defaultChoice(row({ status: 'disk-changed' }))).toBe('disk')
  })

  it('pre-selects skip for a real conflict and an unfamiliar disk file', () => {
    expect(defaultChoice(row({ status: 'both-changed' }))).toBe('skip')
    expect(defaultChoice(row({ status: 'disk-new' }))).toBe('skip')
  })

  it('pre-selects skip for in-sync (never offered, but never a silent action either)', () => {
    expect(defaultChoice(row({ status: 'in-sync' }))).toBe('skip')
  })
})

describe('summarize', () => {
  it('counts zero of everything for an empty list', () => {
    const counts = summarize([])
    for (const status of ALL_STATUSES) {
      expect(counts[status]).toBe(0)
    }
  })

  it('counts each row under its own status', () => {
    const rows = [
      row({ status: 'in-sync', path: 'a' }),
      row({ status: 'in-sync', path: 'b' }),
      row({ status: 'mesa-changed', path: 'c' }),
      row({ status: 'both-changed', path: 'd' }),
    ]
    const counts = summarize(rows)
    expect(counts['in-sync']).toBe(2)
    expect(counts['mesa-changed']).toBe(1)
    expect(counts['both-changed']).toBe(1)
    expect(counts['disk-new']).toBe(0)
  })
})

describe('resolutionsFor', () => {
  it('omits in-sync rows entirely', () => {
    const rows = [row({ status: 'in-sync', path: 'a' }), row({ status: 'mesa-changed', path: 'b' })]
    const result = resolutionsFor(rows, {})
    expect(result).toEqual([{ path: 'b', choice: 'mesa' }])
  })

  it('falls back to defaultChoice for a row with no explicit choice', () => {
    const rows = [row({ status: 'disk-changed', path: 'x' })]
    expect(resolutionsFor(rows, {})).toEqual([{ path: 'x', choice: 'disk' }])
  })

  it('uses the explicit choice over the default when one is given', () => {
    const rows = [row({ status: 'disk-changed', path: 'x' })]
    expect(resolutionsFor(rows, { x: 'skip' })).toEqual([{ path: 'x', choice: 'skip' }])
  })

  it('resolves a whole mixed batch in row order', () => {
    const rows = [
      row({ status: 'in-sync', path: 'a' }),
      row({ status: 'mesa-new', path: 'b' }),
      row({ status: 'both-changed', path: 'c' }),
    ]
    expect(resolutionsFor(rows, { c: 'mesa' })).toEqual([
      { path: 'b', choice: 'mesa' },
      { path: 'c', choice: 'mesa' },
    ])
  })
})

describe('rowKey', () => {
  it('differs for two rows that share a path (the backend bug this guards against)', () => {
    const a = row({ item_id: null, builtin_id: null, path: '.claude/CLAUDE.md', status: 'disk-new' })
    const b = row({
      item_id: null,
      builtin_id: 'starter-claude-md',
      path: '.claude/CLAUDE.md',
      status: 'both-changed',
    })
    expect(rowKey(a, 0)).not.toBe(rowKey(b, 1))
  })

  it('differs by index alone when item_id, builtin_id and path are all identical', () => {
    const a = row({ path: 'x' })
    const b = row({ path: 'x' })
    expect(rowKey(a, 0)).not.toBe(rowKey(b, 1))
  })

  it('is stable for the same row and index', () => {
    const a = row({ item_id: 3, path: 'x' })
    expect(rowKey(a, 2)).toBe(rowKey(a, 2))
  })
})

describe('resultLabel', () => {
  function result(overrides: Partial<LibrarySyncResult> = {}): LibrarySyncResult {
    return { path: 'x', choice: 'mesa', applied: false, error: null, ...overrides }
  }

  it('reads "applied" when applied is true', () => {
    expect(resultLabel(result({ applied: true, error: null }))).toBe('applied')
  })

  it('reads "skipped" — not "failed" — for a no-op skip (applied: false, error: null)', () => {
    expect(resultLabel(result({ applied: false, error: null }))).toBe('skipped')
  })

  it('reads as a failure only when error is non-null', () => {
    expect(resultLabel(result({ applied: false, error: 'permission denied' }))).toBe(
      'failed — permission denied',
    )
  })
})
