import { describe, expect, it } from 'vitest'
import { promptEnvVar, promptPlaceholders } from './promptPlaceholders'
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
    synced_body: null,
    synced_at: null,
    created_at: null,
    updated_at: null,
    ...overrides,
  }
}

describe('promptEnvVar', () => {
  it('uppercases and folds a dash, mirroring config::prompt_env_var', () => {
    expect(promptEnvVar('nightly-brief')).toBe('MESA_PROMPT_NIGHTLY_BRIEF')
    expect(promptEnvVar('Brief')).toBe('MESA_PROMPT_BRIEF')
    expect(promptEnvVar('a_b')).toBe('MESA_PROMPT_A_B')
  })

  it('refuses a name no environment variable could hold', () => {
    // A library name may contain `.`; a variable name may not.
    expect(promptEnvVar('my.brief')).toBeNull()
    expect(promptEnvVar('')).toBeNull()
  })
})

describe('promptPlaceholders', () => {
  it('offers only prompt items, as their placeholder form', () => {
    expect(
      promptPlaceholders([
        item({ name: 'nightly-brief' }),
        item({ name: 'supervisor', kind: 'agent' }),
        item({ name: 'stop-notify.sh', kind: 'hook' }),
      ]),
    ).toEqual([
      {
        name: 'nightly-brief',
        placeholder: '{prompt:nightly-brief}',
        envVar: 'MESA_PROMPT_NIGHTLY_BRIEF',
        usable: true,
      },
    ])
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

  it('lists an impossible name but marks it unusable', () => {
    // Hiding it would read as "the library lost it"; this says what a save
    // would say.
    expect(promptPlaceholders([item({ name: 'my.brief' })])).toEqual([
      {
        name: 'my.brief',
        placeholder: '{prompt:my.brief}',
        envVar: '',
        usable: false,
      },
    ])
  })

  it('is empty when the library holds no prompts', () => {
    expect(promptPlaceholders([])).toEqual([])
    expect(promptPlaceholders([item({ kind: 'skill' })])).toEqual([])
  })
})
