import { describe, expect, it } from 'vitest'
import {
  BODY_MAX_BYTES,
  LIBRARY_KINDS,
  LIBRARY_SCOPES,
  NAME_MAX,
  bodyError,
  draftError,
  draftFrom,
  emptyDraft,
  isDirty,
  isSavable,
  kindLabel,
  nameError,
  payloadFor,
  scopeLabel,
  type LibraryDraft,
} from './libraryDraft'
import type { LibraryItem } from './types/LibraryItem'

function item(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: 1,
    name: 'my-agent',
    kind: 'agent',
    scope: 'user',
    project_id: null,
    body: 'hello',
    builtin_id: null,
    builtin: false,
    path: '.claude/agents/my-agent.md',
    synced_body: null,
    synced_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('emptyDraft / draftFrom', () => {
  it('starts blank, agent/user', () => {
    expect(emptyDraft()).toEqual({
      kind: 'agent',
      scope: 'user',
      projectId: '',
      name: '',
      body: '',
    })
  })

  it('seeds from a user-scoped item with no project', () => {
    const draft = draftFrom(item())
    expect(draft).toEqual({
      kind: 'agent',
      scope: 'user',
      projectId: '',
      name: 'my-agent',
      body: 'hello',
    })
  })

  it('seeds projectId from a project-scoped item', () => {
    const draft = draftFrom(item({ scope: 'project', project_id: 7 }))
    expect(draft.scope).toBe('project')
    expect(draft.projectId).toBe('7')
  })
})

describe('kindLabel / scopeLabel', () => {
  it('labels every kind', () => {
    expect(LIBRARY_KINDS.map(kindLabel)).toEqual([
      'Agent',
      'Skill',
      'Hook',
      'Command',
      'Prompt',
      'CLAUDE.md',
    ])
  })

  it('labels every scope', () => {
    expect(LIBRARY_SCOPES.map(scopeLabel)).toEqual(['User', 'Project'])
  })
})

describe('nameError', () => {
  it('rejects empty', () => {
    expect(nameError('')).not.toBeNull()
  })

  it('rejects over the max length', () => {
    expect(nameError('a'.repeat(NAME_MAX))).toBeNull()
    expect(nameError('a'.repeat(NAME_MAX + 1))).not.toBeNull()
  })

  it('rejects "." and ".."', () => {
    expect(nameError('.')).not.toBeNull()
    expect(nameError('..')).not.toBeNull()
  })

  it('rejects a slash or backslash anywhere in the name', () => {
    expect(nameError('a/b')).not.toBeNull()
    expect(nameError('a\\b')).not.toBeNull()
    expect(nameError('../etc')).not.toBeNull()
  })

  it('rejects a name starting with a character outside [A-Za-z0-9]', () => {
    expect(nameError('-leading-dash')).not.toBeNull()
    expect(nameError('.leading-dot')).not.toBeNull()
    expect(nameError('_leading-underscore')).not.toBeNull()
  })

  it('accepts a name using the allowed charset after the first character', () => {
    expect(nameError('stop-notify')).toBeNull()
    expect(nameError('a1._-Z9')).toBeNull()
    expect(nameError('CLAUDE.md')).toBeNull()
  })
})

describe('bodyError', () => {
  it('accepts an empty body', () => {
    expect(bodyError('')).toBeNull()
  })

  it('accepts exactly the byte limit', () => {
    expect(bodyError('a'.repeat(BODY_MAX_BYTES))).toBeNull()
  })

  it('rejects one byte over the limit', () => {
    expect(bodyError('a'.repeat(BODY_MAX_BYTES + 1))).not.toBeNull()
  })

  it('measures UTF-8 bytes, not JS string length', () => {
    // Each 🎉 is 4 bytes in UTF-8 but only 2 UTF-16 code units in `.length`.
    const emoji = '🎉'
    const count = Math.floor(BODY_MAX_BYTES / 4) + 1
    const body = emoji.repeat(count)
    expect(body.length).toBeLessThan(BODY_MAX_BYTES)
    expect(bodyError(body)).not.toBeNull()
  })
})

describe('draftError / isSavable', () => {
  function valid(): LibraryDraft {
    return { kind: 'agent', scope: 'user', projectId: '', name: 'ok-name', body: 'body' }
  }

  it('accepts a valid user-scoped draft', () => {
    expect(draftError(valid())).toBeNull()
    expect(isSavable(valid())).toBe(true)
  })

  it('accepts a valid project-scoped draft', () => {
    const draft = { ...valid(), scope: 'project' as const, projectId: '3' }
    expect(draftError(draft)).toBeNull()
  })

  it('rejects a bad name before checking anything else', () => {
    const draft = { ...valid(), name: '' }
    expect(draftError(draft)).toMatch(/name/)
    expect(isSavable(draft)).toBe(false)
  })

  it('rejects a body over the limit', () => {
    const draft = { ...valid(), body: 'a'.repeat(BODY_MAX_BYTES + 1) }
    expect(draftError(draft)).not.toBeNull()
  })

  it('rejects a project scope with no project chosen', () => {
    const draft = { ...valid(), scope: 'project' as const, projectId: '' }
    expect(draftError(draft)).toMatch(/project/)
  })

  it('rejects a user scope with a project chosen', () => {
    const draft = { ...valid(), scope: 'user' as const, projectId: '3' }
    expect(draftError(draft)).toMatch(/project/)
  })
})

describe('payloadFor', () => {
  it('trims the name but sends the body verbatim', () => {
    const payload = payloadFor({
      kind: 'hook',
      scope: 'user',
      projectId: '',
      name: '  spacey  ',
      body: '  keep me  ',
    })
    expect(payload.name).toBe('spacey')
    expect(payload.body).toBe('  keep me  ')
  })

  it('nulls project_id for a user scope even if projectId is stray-set', () => {
    const payload = payloadFor({
      kind: 'agent',
      scope: 'user',
      projectId: '5',
      name: 'n',
      body: '',
    })
    expect(payload.project_id).toBeNull()
  })

  it('numbers project_id for a project scope', () => {
    const payload = payloadFor({
      kind: 'agent',
      scope: 'project',
      projectId: '5',
      name: 'n',
      body: '',
    })
    expect(payload.project_id).toBe(5)
  })

  it('nulls project_id for a project scope with no project chosen', () => {
    const payload = payloadFor({
      kind: 'agent',
      scope: 'project',
      projectId: '',
      name: 'n',
      body: '',
    })
    expect(payload.project_id).toBeNull()
  })
})

describe('isDirty', () => {
  it('is false for a blank new-item draft', () => {
    expect(isDirty(null, emptyDraft())).toBe(false)
  })

  it('is true once a new-item draft has a name or body', () => {
    expect(isDirty(null, { ...emptyDraft(), name: 'x' })).toBe(true)
    expect(isDirty(null, { ...emptyDraft(), body: 'x' })).toBe(true)
  })

  it('is false when an existing item is unchanged', () => {
    const existing = item()
    expect(isDirty(existing, draftFrom(existing))).toBe(false)
  })

  it('is true when the name changed', () => {
    const existing = item()
    const draft = { ...draftFrom(existing), name: 'renamed' }
    expect(isDirty(existing, draft)).toBe(true)
  })

  it('is true when the body changed', () => {
    const existing = item()
    const draft = { ...draftFrom(existing), body: 'different' }
    expect(isDirty(existing, draft)).toBe(true)
  })

  it('trims the name before comparing, so trailing whitespace alone is not dirty', () => {
    const existing = item({ name: 'my-agent' })
    const draft = { ...draftFrom(existing), name: 'my-agent  ' }
    expect(isDirty(existing, draft)).toBe(false)
  })
})
