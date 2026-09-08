import { describe, expect, it } from 'vitest'
import { historyEntries } from './libraryHistory'
import { DIFF_MAX_LINES } from './libraryOverride'
import type { LibraryVersion } from './types/LibraryVersion'

function version(overrides: Partial<LibraryVersion> = {}): LibraryVersion {
  return {
    id: 1,
    item_id: 7,
    body: 'a\n',
    source: 'edit',
    created_at: '2026-09-05 21:03:00',
    ...overrides,
  }
}

describe('historyEntries', () => {
  it('keeps the newest-first order it was given', () => {
    const entries = historyEntries([
      version({ id: 3, body: 'c\n' }),
      version({ id: 2, body: 'b\n' }),
      version({ id: 1, body: 'a\n' }),
    ])
    expect(entries.map((e) => e.version.id)).toEqual([3, 2, 1])
  })

  it('pairs each version with the one immediately older', () => {
    const entries = historyEntries([
      version({ id: 2, body: 'new\n' }),
      version({ id: 1, body: 'old\n' }),
    ])
    expect(entries[0].previousBody).toBe('old\n')
    expect(entries[1].previousBody).toBeNull()
  })

  it('gives the oldest entry no previous, no diff and no counts', () => {
    const entries = historyEntries([
      version({ id: 2, body: 'new\n' }),
      version({ id: 1, body: 'old\n' }),
    ])
    const oldest = entries[1]
    expect(oldest.previousBody).toBeNull()
    expect(oldest.diff).toBeNull()
    expect(oldest.added).toBeNull()
    expect(oldest.removed).toBeNull()
  })

  it('counts exactly the diff lines it reports', () => {
    const entries = historyEntries([
      version({ id: 2, body: 'keep\nadded one\nadded two\n' }),
      version({ id: 1, body: 'keep\ngone\n' }),
    ])
    const entry = entries[0]
    expect(entry.added).toBe(2)
    expect(entry.removed).toBe(1)
    const diff = entry.diff!
    expect(diff.filter((l) => l.kind === 'disk-only')).toHaveLength(entry.added!)
    expect(diff.filter((l) => l.kind === 'mesa-only')).toHaveLength(entry.removed!)
  })

  it('reports no counts for a diff that degraded to a marker', () => {
    // Two bodies with nothing in common and more lines than `diffLines` will
    // report: the answer it gives is cut, so counting it would understate.
    const older = Array.from({ length: DIFF_MAX_LINES }, (_, i) => `old ${i}`).join('\n')
    const newer = Array.from({ length: DIFF_MAX_LINES }, (_, i) => `new ${i}`).join('\n')
    const entries = historyEntries([
      version({ id: 2, body: newer }),
      version({ id: 1, body: older }),
    ])
    expect(entries[0].diff).not.toBeNull()
    expect(entries[0].added).toBeNull()
    expect(entries[0].removed).toBeNull()
  })

  it('labels only the oldest version created, whatever its stored source', () => {
    const entries = historyEntries([
      version({ id: 3, source: 'sync-pull', body: 'c\n' }),
      version({ id: 2, source: 'edit', body: 'b\n' }),
      version({ id: 1, source: 'edit', body: 'a\n' }),
    ])
    expect(entries.map((e) => e.sourceLabel)).toEqual(['sync-pull', 'edit', 'created'])
  })

  it('treats a lone version as the oldest one', () => {
    const entries = historyEntries([version({ id: 1, source: 'edit' })])
    expect(entries).toHaveLength(1)
    expect(entries[0].previousBody).toBeNull()
    expect(entries[0].diff).toBeNull()
    expect(entries[0].sourceLabel).toBe('created')
  })

  it('answers an empty list with no entries', () => {
    expect(historyEntries([])).toEqual([])
  })
})
