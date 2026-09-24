import { describe, expect, it } from 'vitest'
import { builtinReview } from './libraryBuiltinUpdate'
import type { LibraryItem } from './types/LibraryItem'

function fork(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: 21,
    name: 'naru-live',
    kind: 'agent',
    scope: 'user',
    project_id: null,
    body: 'my fork',
    builtin_id: 'naru-live',
    builtin: false,
    path: '.claude/agents/naru-live.md',
    export_command: false,
    synced_body: null,
    synced_at: null,
    created_at: null,
    updated_at: null,
    builtin_updated: true,
    builtin_body: 'the new built-in',
    ...overrides,
  }
}

describe('builtinReview', () => {
  it('offers the fork and the current built-in for a flagged fork', () => {
    expect(builtinReview(fork())).toEqual({ fork: 'my fork', builtin: 'the new built-in' })
  })

  it('offers nothing for a fork that is not flagged', () => {
    expect(builtinReview(fork({ builtin_updated: false }))).toBeNull()
  })

  it('offers nothing for an unshadowed built-in, which has no row to decide on', () => {
    expect(
      builtinReview(fork({ id: null, builtin: true, builtin_updated: true })),
    ).toBeNull()
  })

  it('offers nothing when the built-in body is missing (the built-in is gone)', () => {
    expect(builtinReview(fork({ builtin_body: null }))).toBeNull()
  })
})
