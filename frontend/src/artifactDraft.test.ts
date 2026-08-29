import { describe, expect, it } from 'vitest'
import {
  BODY_MAX_BYTES,
  CONTENT_TYPES,
  NAME_MAX,
  bodyError,
  contentTypeError,
  createPayload,
  draftError,
  draftFrom,
  emptyDraft,
  isDirty,
  isSavable,
  nameError,
  patchPayload,
  renderKindFor,
  type ArtifactDraft,
} from './artifactDraft'
import type { Artifact } from './types/Artifact'

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 1,
    project_id: 3,
    task_id: null,
    name: 'preview',
    content_type: 'text/html',
    body: '<p>hi</p>',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('emptyDraft / draftFrom', () => {
  it('starts blank, text/html', () => {
    expect(emptyDraft()).toEqual({
      name: '',
      contentType: 'text/html',
      taskId: '',
      body: '',
    })
  })

  it('seeds from a stored artifact with no task', () => {
    const draft = draftFrom(artifact())
    expect(draft).toEqual({
      name: 'preview',
      contentType: 'text/html',
      taskId: '',
      body: '<p>hi</p>',
    })
  })

  it('seeds taskId from a bound artifact', () => {
    const draft = draftFrom(artifact({ task_id: 42 }))
    expect(draft.taskId).toBe('42')
  })
})

describe('renderKindFor', () => {
  it('renders text/html as an iframe', () => {
    expect(renderKindFor('text/html')).toBe('iframe')
  })

  it('renders image/svg+xml as an iframe', () => {
    expect(renderKindFor('image/svg+xml')).toBe('iframe')
  })

  it('renders text/markdown as markdown, never an iframe', () => {
    expect(renderKindFor('text/markdown')).toBe('markdown')
  })

  it('every allowed content type resolves to a known render kind', () => {
    for (const ct of CONTENT_TYPES) {
      expect(['iframe', 'markdown']).toContain(renderKindFor(ct))
    }
  })
})

describe('nameError', () => {
  it('rejects empty and whitespace-only', () => {
    expect(nameError('')).not.toBeNull()
    expect(nameError('   ')).not.toBeNull()
  })

  it('accepts exactly the max length, rejects one over', () => {
    expect(nameError('a'.repeat(NAME_MAX))).toBeNull()
    expect(nameError('a'.repeat(NAME_MAX + 1))).not.toBeNull()
  })

  it('accepts an ordinary name', () => {
    expect(nameError('release notes')).toBeNull()
  })
})

describe('bodyError', () => {
  it('rejects an empty body — unlike a library item, an artifact body is required', () => {
    expect(bodyError('')).not.toBeNull()
  })

  it('rejects a whitespace-only body — emptiness is judged by trim(), matching validate_artifact_body', () => {
    expect(bodyError('   \n  ')).not.toBeNull()
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

describe('contentTypeError', () => {
  it('accepts every allowed value', () => {
    for (const ct of CONTENT_TYPES) {
      expect(contentTypeError(ct)).toBeNull()
    }
  })

  it('rejects anything outside the three-value allowlist', () => {
    expect(contentTypeError('text/plain')).not.toBeNull()
    expect(contentTypeError('application/json')).not.toBeNull()
    expect(contentTypeError('')).not.toBeNull()
  })
})

describe('draftError / isSavable', () => {
  function valid(): ArtifactDraft {
    return { name: 'ok', contentType: 'text/html', taskId: '', body: '<p>ok</p>' }
  }

  it('accepts a valid draft', () => {
    expect(draftError(valid())).toBeNull()
    expect(isSavable(valid())).toBe(true)
  })

  it('rejects a bad name before checking anything else', () => {
    const draft = { ...valid(), name: '' }
    expect(draftError(draft)).toMatch(/name/)
    expect(isSavable(draft)).toBe(false)
  })

  it('rejects an empty body', () => {
    const draft = { ...valid(), body: '' }
    expect(draftError(draft)).toMatch(/body/)
  })

  it('rejects a bad content type', () => {
    const draft = { ...valid(), contentType: 'text/plain' }
    expect(draftError(draft)).not.toBeNull()
  })

  it('accepts a draft bound to a task', () => {
    const draft = { ...valid(), taskId: '9' }
    expect(draftError(draft)).toBeNull()
  })
})

describe('createPayload', () => {
  it('carries the project id from its own argument, not the draft', () => {
    const payload = createPayload(7, {
      name: '  spacey  ',
      contentType: 'text/markdown',
      taskId: '',
      body: '# hi',
    })
    expect(payload.project_id).toBe(7)
    expect(payload.task_id).toBeNull()
    expect(payload.name).toBe('spacey')
    expect(payload.content_type).toBe('text/markdown')
    expect(payload.body).toBe('# hi')
  })

  it('numbers task_id when a task is chosen', () => {
    const payload = createPayload(7, {
      name: 'n',
      contentType: 'text/html',
      taskId: '12',
      body: 'b',
    })
    expect(payload.task_id).toBe(12)
  })
})

describe('patchPayload', () => {
  it('trims the name but sends the body verbatim, and carries no project_id', () => {
    const payload = patchPayload({
      name: '  spacey  ',
      contentType: 'text/html',
      taskId: '',
      body: '  keep me  ',
    })
    expect(payload).not.toHaveProperty('project_id')
    expect(payload.name).toBe('spacey')
    expect(payload.body).toBe('  keep me  ')
    expect(payload.task_id).toBeNull()
  })
})

describe('isDirty', () => {
  it('is false for a blank new-artifact draft', () => {
    expect(isDirty(null, emptyDraft())).toBe(false)
  })

  it('is true once a new-artifact draft has a name, body or task', () => {
    expect(isDirty(null, { ...emptyDraft(), name: 'x' })).toBe(true)
    expect(isDirty(null, { ...emptyDraft(), body: 'x' })).toBe(true)
    expect(isDirty(null, { ...emptyDraft(), taskId: '1' })).toBe(true)
  })

  it('is false when an existing artifact is unchanged', () => {
    const existing = artifact()
    expect(isDirty(existing, draftFrom(existing))).toBe(false)
  })

  it('is true when the name, body, content type or task changed', () => {
    const existing = artifact()
    expect(isDirty(existing, { ...draftFrom(existing), name: 'renamed' })).toBe(true)
    expect(isDirty(existing, { ...draftFrom(existing), body: 'different' })).toBe(true)
    expect(
      isDirty(existing, { ...draftFrom(existing), contentType: 'text/markdown' }),
    ).toBe(true)
    expect(isDirty(existing, { ...draftFrom(existing), taskId: '9' })).toBe(true)
  })

  it('trims the name before comparing, so trailing whitespace alone is not dirty', () => {
    const existing = artifact({ name: 'preview' })
    const draft = { ...draftFrom(existing), name: 'preview  ' }
    expect(isDirty(existing, draft)).toBe(false)
  })
})
