import type { LibraryItem } from './types/LibraryItem'
import type { LibraryKind } from './types/LibraryKind'
import type { LibraryScope } from './types/LibraryScope'

/**
 * Pure draft logic for the Library page's authoring form, hoisted out of the
 * component so it is unit-testable (CLAUDE.md: the frontend tests cover the
 * pure logic modules, never a rendered tree) — the `scriptDraft.ts` pattern.
 *
 * Every field is held as a **string**, never parsed mid-keystroke: a
 * half-typed name has to survive the keystroke that produced it. Parsing
 * happens once, on the way out, in `payloadFor`.
 *
 * `kind`, `scope` and `project_id` are set at creation and never change
 * afterward — the PATCH contract only ever carries `name`/`body` — so once an
 * item exists, `isDirty`/`payloadFor` only need to track those two fields.
 * The rules mirror `Store`'s validators for `library_items`
 * (`.scratch/library-design.md`): the name charset/length and the 1 MiB body
 * bound.
 */

/** The six kinds, in the order the authoring form offers them. */
export const LIBRARY_KINDS: LibraryKind[] = [
  'agent',
  'skill',
  'hook',
  'command',
  'prompt',
  'claude-md',
]

/** The two scopes, in the order the authoring form offers them. */
export const LIBRARY_SCOPES: LibraryScope[] = ['user', 'project']

/** Longest allowed name — `library_items.name`, half of a filename. */
export const NAME_MAX = 100

/** Largest allowed body, in UTF-8 bytes — the same 1 MiB bound the store
 * enforces on `library_items.body`. */
export const BODY_MAX_BYTES = 1024 * 1024

/** The whole create form. `projectId` is `''` for a user-scoped item or an
 * unset project-scoped one, the same empty-option convention the `<select>`
 * renders (`scriptDraft.ts::ScriptDraft`). */
export interface LibraryDraft {
  kind: LibraryKind
  scope: LibraryScope
  projectId: string
  name: string
  body: string
}

/** A blank form for the "new item" button. */
export function emptyDraft(): LibraryDraft {
  return { kind: 'agent', scope: 'user', projectId: '', name: '', body: '' }
}

/** The editable text for a stored item (or an unshadowed built-in, which
 * `draftError`/`isSavable` treat the same as any other draft). */
export function draftFrom(item: LibraryItem): LibraryDraft {
  return {
    kind: item.kind,
    scope: item.scope,
    projectId: item.project_id === null ? '' : String(item.project_id),
    name: item.name,
    body: item.body,
  }
}

/** Display label for a kind, as offered in the picker and shown on a card. */
export function kindLabel(kind: LibraryKind): string {
  switch (kind) {
    case 'agent':
      return 'Agent'
    case 'skill':
      return 'Skill'
    case 'hook':
      return 'Hook'
    case 'command':
      return 'Command'
    case 'prompt':
      return 'Prompt'
    case 'claude-md':
      return 'CLAUDE.md'
  }
}

/** Display label for a scope. */
export function scopeLabel(scope: LibraryScope): string {
  return scope === 'user' ? 'User' : 'Project'
}

/**
 * The error this name would earn from `Store`, or `null`. The charset is the
 * traversal chokepoint (`.scratch/library-design.md`): a name can never
 * contain `/`, `\` or `..`, so a path is built from it, never parsed.
 */
export function nameError(name: string): string | null {
  if (name === '') return 'a name is required'
  if (name.length > NAME_MAX) return `a name is at most ${NAME_MAX} characters`
  if (name === '.' || name === '..') return `"${name}" is not a valid name`
  if (name.includes('/') || name.includes('\\')) {
    return 'a name may not contain "/" or "\\"'
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    return `invalid name "${name}": use ^[A-Za-z0-9][A-Za-z0-9._-]*$`
  }
  return null
}

/** The error this body would earn, or `null` — measured in UTF-8 bytes
 * (`TextEncoder`), not JS string length, since a multi-byte character costs
 * more on the wire than `.length` reports. */
export function bodyError(body: string): string | null {
  const bytes = new TextEncoder().encode(body).length
  if (bytes > BODY_MAX_BYTES) {
    return `body is at most ${BODY_MAX_BYTES} bytes (currently ${bytes})`
  }
  return null
}

/**
 * The first error the whole form would earn, or `null` when it is ready to
 * save. Uniqueness of `(kind, scope, project_id, name)` is not mirrored —
 * that is a `conflict` only the db can answer, so it surfaces from the
 * failed request.
 */
export function draftError(draft: LibraryDraft): string | null {
  const n = nameError(draft.name)
  if (n !== null) return n
  const b = bodyError(draft.body)
  if (b !== null) return b
  if (draft.scope === 'project' && draft.projectId === '') {
    return 'a project-scoped item needs a project'
  }
  if (draft.scope === 'user' && draft.projectId !== '') {
    return 'a user-scoped item may not bind a project'
  }
  return null
}

/** True when the save button does something valid. */
export function isSavable(draft: LibraryDraft): boolean {
  return draftError(draft) === null
}

/** The create-request body for this draft: `kind`/`scope`/`project_id` are
 * only meaningful here, at creation — see the module note. `name` is
 * trimmed; `body` is sent verbatim (it may be a program or a hook script —
 * trimming it would edit the user's content). */
export function payloadFor(draft: LibraryDraft): {
  kind: LibraryKind
  scope: LibraryScope
  project_id: number | null
  name: string
  body: string
} {
  return {
    kind: draft.kind,
    scope: draft.scope,
    project_id:
      draft.scope === 'project' && draft.projectId !== '' ? Number(draft.projectId) : null,
    name: draft.name.trim(),
    body: draft.body,
  }
}

/**
 * True when the form differs from what the server last reported. For an
 * existing item this only ever compares `name`/`body` — `kind`/`scope`/
 * `project_id` cannot be edited once an item exists, so a stale mismatch on
 * those fields (there is none — `draftFrom` seeds them from `item`) would
 * never be user-editable input anyway.
 */
export function isDirty(item: LibraryItem | null, draft: LibraryDraft): boolean {
  const payload = payloadFor(draft)
  if (item === null) {
    return payload.name !== '' || payload.body !== ''
  }
  return payload.name !== item.name || payload.body !== item.body
}
