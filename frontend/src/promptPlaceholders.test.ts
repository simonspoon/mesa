import { describe, expect, it } from 'vitest'
import { promptPlaceholders } from './promptPlaceholders'
import type { LibraryItem } from './types/LibraryItem'

function item(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: 1,
    name: 'nightly-brief',
    kind: 'prompt',
    scope: 'user',
    project_id: null,
    body: 'read the board',
    builtin_id: null,
    builtin: false,
    path: null,
    export_command: false,
    synced_body: null,
    synced_at: null,
    created_at: null,
    updated_at: null,
    ...overrides,
  }
}

describe('promptPlaceholders', () => {
  it('offers only prompt items, as their placeholder form', () => {
    expect(
      promptPlaceholders([
        item({ name: 'nightly-brief' }),
        item({ name: 'supervisor', kind: 'agent' }),
        item({ name: 'stop-notify.sh', kind: 'hook' }),
      ]),
    ).toEqual([{ name: 'nightly-brief', placeholder: '{prompt:nightly-brief}' }])
  })

  it('sorts by name case-insensitively', () => {
    expect(
      promptPlaceholders([
        item({ name: 'zeta' }),
        item({ name: 'Alpha' }),
        item({ name: 'beta' }),
      ]).map((p) => p.name),
    ).toEqual(['Alpha', 'beta', 'zeta'])
  })

  it('keeps the first of two names that differ only in case', () => {
    // `config::Prompts::new` resolves case-insensitively and keeps the first
    // row in the library's own order; the page must not offer a second entry
    // no template could ever reach.
    expect(
      promptPlaceholders([item({ name: 'Brief' }), item({ name: 'brief' })]).map(
        (p) => p.name,
      ),
    ).toEqual(['Brief'])
  })

  it('offers any library name, a dot included', () => {
    // Since mesa task 1143 a prompt body is quoted into the script like every
    // other value, so a name no longer has to fit an environment variable.
    expect(promptPlaceholders([item({ name: 'my.brief' })])).toEqual([
      { name: 'my.brief', placeholder: '{prompt:my.brief}' },
    ])
  })

  it('is empty when the library holds no prompts', () => {
    expect(promptPlaceholders([])).toEqual([])
    expect(promptPlaceholders([item({ kind: 'skill' })])).toEqual([])
  })
})
