import type { Artifact } from './types/Artifact'

/**
 * Pure draft logic for the Artifacts tab's authoring form, hoisted out of the
 * component so it is unit-testable (CLAUDE.md: the frontend tests cover the
 * pure logic modules, never a rendered tree) — the `scriptDraft.ts`/
 * `libraryDraft.ts` pattern.
 *
 * Every field is held as a **string**, never parsed mid-keystroke: a
 * half-typed name has to survive the keystroke that produced it. Parsing
 * happens once, on the way out, in `createPayload`/`patchPayload`.
 *
 * `project_id` is set at creation and never changes afterward (an artifact's
 * URL is `/api/projects/{id}/artifacts/…`, mirroring a task's own immutable
 * project — .scratch/artifacts-spec.md §1), so this draft never carries it:
 * `createPayload` takes the project id as its own argument, and
 * `patchPayload`/`isDirty` only ever compare `name`/`content_type`/`body`/
 * `task_id`.
 *
 * NOTE: `Artifact` here is an unrelated record type from `Task.artifact` — the
 * existing bounded pointer string (a SHA/PR URL/path) a task carries at
 * close-out. Same word, two different things.
 */

/**
 * The three allowed `content_type` values, mirroring the allowlist
 * `Store::create_artifact`/`update_artifact` enforce
 * (`files::image_mime`'s posture). Anything else is `validation` — a fourth
 * value is a change to the render route and the web renderer, never a free
 * addition (spec §1).
 */
export const CONTENT_TYPES = ['text/html', 'image/svg+xml', 'text/markdown'] as const

export type ArtifactContentType = (typeof CONTENT_TYPES)[number]

/** Longest allowed name — `Store`'s `name` bound. */
export const NAME_MAX = 200

/** Largest allowed body, in UTF-8 bytes — `ARTIFACT_BODY_MAX` (2 MiB). The
 * live surface's 8 KiB `LIVE_TEXT_MAX` does not apply here: an artifact is
 * read, never spoken (spec §1). */
export const BODY_MAX_BYTES = 2 * 1024 * 1024

/** How a given `content_type` renders — the security-relevant branch, so it
 * is a pure, unit-tested decision rather than a conditional buried in JSX.
 * `iframe` covers both sandboxable types (`text/html`, `image/svg+xml`);
 * `markdown` is the one type that never gets a frame, rendered instead
 * through the app's own `<Markdown>` (spec §5). */
export type RenderKind = 'iframe' | 'markdown'

export function renderKindFor(contentType: string): RenderKind {
  return contentType === 'text/markdown' ? 'markdown' : 'iframe'
}

/** The whole create/edit form. `taskId` is `''` for an unbound artifact, the
 * same empty-option convention `scriptDraft.ts::ScriptDraft.projectId`
 * renders. */
export interface ArtifactDraft {
  name: string
  contentType: string
  taskId: string
  body: string
}

/** A blank form for the "new artifact" button. `text/html` is the CLI's own
 * default (spec §3), so it is this form's too. */
export function emptyDraft(): ArtifactDraft {
  return { name: '', contentType: 'text/html', taskId: '', body: '' }
}

/** The editable text for a stored artifact. */
export function draftFrom(artifact: Artifact): ArtifactDraft {
  return {
    name: artifact.name,
    contentType: artifact.content_type,
    taskId: artifact.task_id === null ? '' : String(artifact.task_id),
    body: artifact.body,
  }
}

/** The error this name would earn from `Store`, or `null`. Uniqueness within
 * a project is not mirrored — that is a `conflict` only the db can answer, so
 * it surfaces from the failed request. */
export function nameError(name: string): string | null {
  const trimmed = name.trim()
  if (trimmed === '') return 'a name is required'
  if (trimmed.length > NAME_MAX) return `a name is at most ${NAME_MAX} characters`
  return null
}

/** The error this body would earn, or `null`. Emptiness is judged by
 * `trim()`, mirroring `validate_artifact_body`/`validate_script_body` — the
 * stored value is still verbatim (trimming it would edit the document
 * itself). The size check is measured in UTF-8 bytes (`TextEncoder`), not JS
 * string length, mirroring `libraryDraft.ts::bodyError`. */
export function bodyError(body: string): string | null {
  if (body.trim() === '') return 'a body is required'
  const bytes = new TextEncoder().encode(body).length
  if (bytes > BODY_MAX_BYTES) {
    return `body is at most ${BODY_MAX_BYTES} bytes (currently ${bytes})`
  }
  return null
}

/** The error this content type would earn, or `null`. */
export function contentTypeError(contentType: string): string | null {
  return (CONTENT_TYPES as readonly string[]).includes(contentType)
    ? null
    : `invalid content type "${contentType}": must be one of ${CONTENT_TYPES.join(', ')}`
}

/** The first error the whole form would earn, or `null` when it is ready to
 * save. */
export function draftError(draft: ArtifactDraft): string | null {
  const n = nameError(draft.name)
  if (n !== null) return n
  const b = bodyError(draft.body)
  if (b !== null) return b
  return contentTypeError(draft.contentType)
}

/** True when the save button does something valid. */
export function isSavable(draft: ArtifactDraft): boolean {
  return draftError(draft) === null
}

/** `task_id` off the draft's string form: `''` is unbound. */
function taskIdFor(draft: ArtifactDraft): number | null {
  return draft.taskId === '' ? null : Number(draft.taskId)
}

/** The create-request body for this draft. `project_id` is not part of the
 * draft (module note) — it is the project the tab is already open on. `name`
 * is trimmed; `body` is sent verbatim (trimming it would edit the document
 * itself). */
export function createPayload(
  projectId: number,
  draft: ArtifactDraft,
): {
  project_id: number
  task_id: number | null
  name: string
  content_type: string
  body: string
} {
  return {
    project_id: projectId,
    task_id: taskIdFor(draft),
    name: draft.name.trim(),
    content_type: draft.contentType,
    body: draft.body,
  }
}

/** The patch body for this draft against an existing artifact — every
 * editable field, always sent in full (the `scriptPayload` convention: the
 * form is the whole record minus `project_id`, not a diff). */
export function patchPayload(draft: ArtifactDraft): {
  task_id: number | null
  name: string
  content_type: string
  body: string
} {
  return {
    task_id: taskIdFor(draft),
    name: draft.name.trim(),
    content_type: draft.contentType,
    body: draft.body,
  }
}

/**
 * True when the form differs from what the server last reported — i.e. the
 * save button has work to do. Compared on the *payload*, so whitespace the
 * payload would strip anyway never reads as a pending change.
 */
export function isDirty(artifact: Artifact | null, draft: ArtifactDraft): boolean {
  const next = patchPayload(draft)
  if (artifact === null) {
    return next.name !== '' || next.body !== '' || next.task_id !== null
  }
  return (
    next.name !== artifact.name ||
    next.content_type !== artifact.content_type ||
    next.body !== artifact.body ||
    next.task_id !== artifact.task_id
  )
}
