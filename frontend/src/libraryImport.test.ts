import { describe, expect, it } from 'vitest'
import {
  IMPORT_CHOICES,
  defaultImportChoice,
  importDatesLabel,
  importOrientation,
  importResolutionsFor,
  importRowKey,
  importStatusExplains,
  importStatusLabel,
  isPickable,
  summarizePreview,
  type ImportChoice,
} from './libraryImport'
import type { LibraryImportRow } from './types/LibraryImportRow'
import type { LibraryImportStatus } from './types/LibraryImportStatus'

const STATUSES: LibraryImportStatus[] = ['new', 'identical', 'conflict', 'unresolvable']

function row(over: Partial<LibraryImportRow> = {}): LibraryImportRow {
  return {
    name: 'my-hook',
    kind: 'hook',
    scope: 'user',
    project: null,
    status: 'conflict',
    item_id: 7,
    local_body: 'local',
    bundle_body: 'imported',
    local_updated_at: '2026-01-02 03:04:05',
    diff: null,
    error: null,
    ...over,
  }
}

describe('importStatusLabel', () => {
  it('gives every status a distinct, non-empty label', () => {
    const labels = STATUSES.map(importStatusLabel)
    expect(labels.every((l) => l.length > 0)).toBe(true)
    expect(new Set(labels).size).toBe(STATUSES.length)
  })
})

describe('importStatusExplains', () => {
  it('gives every status a distinct, non-empty sentence', () => {
    const sentences = STATUSES.map(importStatusExplains)
    expect(sentences.every((s) => s.endsWith('.'))).toBe(true)
    expect(new Set(sentences).size).toBe(STATUSES.length)
  })
})

describe('defaultImportChoice', () => {
  it('keeps the local body — the dangerous side is never the default', () => {
    expect(defaultImportChoice()).toBe('skip')
  })

  it('is the default for every status, pickable or not', () => {
    for (const status of STATUSES) {
      const r = row({ status })
      const choice: ImportChoice = defaultImportChoice()
      expect(choice).toBe('skip')
      expect(IMPORT_CHOICES.some((c) => c.value === choice)).toBe(true)
      expect(r.status).toBe(status)
    }
  })
})

describe('isPickable', () => {
  it('is true only for a conflict', () => {
    expect(isPickable(row({ status: 'conflict' }))).toBe(true)
    expect(isPickable(row({ status: 'new', local_body: null, item_id: null }))).toBe(false)
    expect(isPickable(row({ status: 'identical' }))).toBe(false)
  })

  it('is false for an unresolvable row — there is no local row to keep', () => {
    expect(
      isPickable(row({ status: 'unresolvable', error: 'no such project', item_id: null })),
    ).toBe(false)
  })

  it('is false for a row carrying an error, whatever its status says', () => {
    for (const status of STATUSES) {
      expect(isPickable(row({ status, error: 'no such project' }))).toBe(false)
    }
  })
})

describe('importRowKey', () => {
  it('differs for two rows sharing one identity (a malformed bundle)', () => {
    const a = row()
    expect(importRowKey(a, 0)).not.toBe(importRowKey(a, 1))
  })

  it('differs by identity at the same index', () => {
    expect(importRowKey(row({ name: 'a' }), 0)).not.toBe(importRowKey(row({ name: 'b' }), 0))
    expect(importRowKey(row({ kind: 'hook' }), 0)).not.toBe(
      importRowKey(row({ kind: 'skill' }), 0),
    )
  })

  it('is stable for the same row and index', () => {
    expect(importRowKey(row(), 2)).toBe(importRowKey(row(), 2))
  })
})

describe('importResolutionsFor', () => {
  it('omits every row that is not pickable', () => {
    const rows = [
      row({ name: 'fresh', status: 'new', local_body: null, item_id: null }),
      row({ name: 'same', status: 'identical' }),
      row({ name: 'broken', status: 'unresolvable', error: 'no such project' }),
    ]
    expect(importResolutionsFor(rows, {})).toEqual([])
  })

  it('falls back to the default for a conflict nobody touched', () => {
    const rows = [row({ name: 'clash' })]
    expect(importResolutionsFor(rows, {})).toEqual([
      { name: 'clash', kind: 'hook', scope: 'user', project: null, choice: 'skip' },
    ])
  })

  it('uses the explicit choice over the default when one is given', () => {
    const rows = [row({ name: 'clash' })]
    const choices = { [importRowKey(rows[0], 0)]: 'replace' as ImportChoice }
    expect(importResolutionsFor(rows, choices)[0].choice).toBe('replace')
  })

  it('carries a project-scoped item on its project NAME, and resolves a mixed batch in row order', () => {
    const rows = [
      row({ name: 'keep' }),
      row({ name: 'fresh', status: 'new', local_body: null, item_id: null }),
      row({ name: 'take', scope: 'project', project: 'mesa' }),
    ]
    const choices = { [importRowKey(rows[2], 2)]: 'replace' as ImportChoice }
    expect(importResolutionsFor(rows, choices)).toEqual([
      { name: 'keep', kind: 'hook', scope: 'user', project: null, choice: 'skip' },
      { name: 'take', kind: 'hook', scope: 'project', project: 'mesa', choice: 'replace' },
    ])
  })
})

describe('summarizePreview', () => {
  it('says there is nothing to import for an empty bundle', () => {
    expect(summarizePreview([])).toBe('Nothing to import.')
  })

  it('pluralizes a single item correctly', () => {
    expect(summarizePreview([row({ status: 'new' })])).toBe('1 item new.')
  })

  it('lists every non-zero count in new/identical/conflicting/unresolvable order', () => {
    const rows = [
      row({ status: 'conflict' }),
      row({ status: 'new' }),
      row({ status: 'new' }),
      row({ status: 'identical' }),
      row({ status: 'unresolvable', error: 'no such project' }),
    ]
    expect(summarizePreview(rows)).toBe(
      '2 items new, 1 item identical, 1 item conflicting, 1 item unresolvable.',
    )
  })

  it('omits any count that is zero', () => {
    expect(summarizePreview([row({ status: 'identical' })])).toBe('1 item identical.')
  })

  it('counts an unresolvable row under its own status, never as a new one', () => {
    expect(summarizePreview([row({ status: 'unresolvable', error: 'boom' })])).toBe(
      '1 item unresolvable.',
    )
  })
})

describe('importOrientation', () => {
  it('reads local → imported when the pick takes the imported body', () => {
    expect(importOrientation('replace')).toEqual({ from: 'mesa', to: 'disk' })
  })

  it('reads imported → local when the pick keeps the local body', () => {
    expect(importOrientation('skip')).toEqual({ from: 'disk', to: 'mesa' })
  })

  it('always reads toward a side — skip is a decision here, not an absence of one', () => {
    for (const { value } of IMPORT_CHOICES) {
      const o = importOrientation(value)
      expect(o.from).not.toBe(o.to)
    }
  })
})

describe('importDatesLabel', () => {
  it('names both sides, to the minute, and which is newer', () => {
    expect(importDatesLabel(row({ local_updated_at: '2026-01-02 03:04:05' }), '2026-01-01 00:00:00')).toBe(
      'local 2026-01-02 03:04 · imported 2026-01-01 00:00 (local is newer)',
    )
  })

  it('says the imported side is newer when it is', () => {
    expect(importDatesLabel(row({ local_updated_at: '2026-01-01 00:00:00' }), '2026-02-02 03:04:05')).toBe(
      'local 2026-01-01 00:00 · imported 2026-02-02 03:04 (imported is newer)',
    )
  })

  it('drops the verdict when the local side has no date', () => {
    expect(importDatesLabel(row({ local_updated_at: null }), '2026-01-01 00:00:00')).toBe(
      'imported 2026-01-01 00:00',
    )
  })

  it('treats an empty exported_at as no date at all', () => {
    expect(importDatesLabel(row({ local_updated_at: '2026-01-02 03:04:05' }), '')).toBe(
      'local 2026-01-02 03:04',
    )
  })

  it('is null when neither side has a date', () => {
    expect(importDatesLabel(row({ local_updated_at: null }), '')).toBeNull()
  })
})
