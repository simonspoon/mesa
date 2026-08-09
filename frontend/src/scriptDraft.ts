import type { Script } from './types/Script'
import type { ScriptArg } from './types/ScriptArg'
import type { ScriptArgKind } from './types/ScriptArgKind'

/**
 * Pure draft logic for the Scripts page — both of its forms, hoisted out of
 * the components so they are unit-testable (CLAUDE.md: the frontend tests
 * cover the pure modules, never a rendered tree).
 *
 * Two drafts live here and they are not the same thing:
 *
 *  * a **[`ScriptDraft`]** is the *authoring* form — the script's name, body
 *    and the argument list it declares. Its rules mirror
 *    `store.rs::validate_script_name` / `validate_script_body` /
 *    `validate_script_args`.
 *  * a **[`ValueDraft`]** is the *run* form generated from those declared
 *    arguments. Its rules mirror `core/scripts.rs::validate_values`.
 *
 * Every field on both is held as a **string**, never a parsed number and
 * never a `string[]`: a half-typed `1e` or a trailing comma in a choices list
 * has to survive the keystroke that produced it, and the run path has exactly
 * one representation (a string) to hand to the shell anyway. Parsing happens
 * once, on the way out, in [`scriptPayload`] / [`valuesFor`].
 *
 * The mirroring is the point: the server is still the authority and rejects
 * anything wrong, but a form that only learns about a bad argument name after
 * a failed POST is a form that teaches nothing. Keep the two in step — every
 * rule below names the Rust function it copies.
 */

/** The four kinds, in the order the authoring form offers them. */
export const ARG_KINDS: ScriptArgKind[] = ['text', 'number', 'bool', 'choice']

/** Longest allowed argument name — `store.rs::SCRIPT_ARG_NAME_MAX`. */
export const ARG_NAME_MAX = 64

// ---- the authoring form ----

/** One declared argument, mid-edit. `choices` is the raw comma-separated text
 * the user is typing, not a parsed list — see the module note. */
export interface ArgDraft {
  name: string
  label: string
  kind: ScriptArgKind
  required: boolean
  default: string
  choices: string
}

/** The whole create/edit form. `projectId` is `''` for a global script, the
 * same empty-option convention the `<select>` renders. */
export interface ScriptDraft {
  name: string
  description: string
  projectId: string
  body: string
  args: ArgDraft[]
}

/** A blank row for the "add argument" button. */
export function emptyArg(): ArgDraft {
  return { name: '', label: '', kind: 'text', required: false, default: '', choices: '' }
}

/** The comma-separated choices box as a list: trimmed, blanks dropped, so a
 * trailing comma while typing is not yet an empty choice. */
export function parseChoices(raw: string): string[] {
  return raw
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c !== '')
}

/** The editable text for one stored argument. */
export function argDraftFrom(arg: ScriptArg): ArgDraft {
  return {
    name: arg.name,
    label: arg.label ?? '',
    kind: arg.kind,
    required: arg.required,
    default: arg.default ?? '',
    choices: (arg.choices ?? []).join(', '),
  }
}

/** The editable text for a stored script, or a blank form for `null`. */
export function scriptDraftFrom(script: Script | null): ScriptDraft {
  if (script === null) {
    return { name: '', description: '', projectId: '', body: '', args: [] }
  }
  return {
    name: script.name,
    description: script.description ?? '',
    projectId: script.project_id === null ? '' : String(script.project_id),
    body: script.body,
    args: script.args.map(argDraftFrom),
  }
}

/**
 * The error this argument name would earn from
 * `store.rs::validate_script_args`, or `null`. The charset is not cosmetic:
 * the name becomes an `MESA_ARG_*` environment-variable suffix, which is why
 * it is bounded and constrained at all.
 */
export function argNameError(name: string): string | null {
  if (name === '') return 'an argument needs a name'
  if (name.length > ARG_NAME_MAX) return `an argument name is at most ${ARG_NAME_MAX} characters`
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
    return `invalid argument name "${name}": use ^[A-Za-z_][A-Za-z0-9_-]*$`
  }
  return null
}

/** The env-var key two names collide on. `-`→`_` and upper-casing make `a-b`
 * and `A_B` the same variable, so `validate_script_args` dedupes on this. */
function envKey(name: string): string {
  return name.toUpperCase().replace(/-/g, '_')
}

/**
 * The error this argument row would earn on its own, ignoring its neighbours:
 * the name rule above plus the choices rule — `choice` needs a non-empty list
 * and no other kind may carry one.
 */
export function argError(arg: ArgDraft): string | null {
  const nameError = argNameError(arg.name)
  if (nameError !== null) return nameError
  const choices = parseChoices(arg.choices)
  if (arg.kind === 'choice' && choices.length === 0) {
    return `argument "${arg.name}" is a choice and needs a non-empty choices list`
  }
  if (arg.kind !== 'choice' && choices.length > 0) {
    return `argument "${arg.name}" is a ${arg.kind} and may not carry choices`
  }
  return null
}

/** The first error across the whole argument list, uniqueness included. */
export function argsError(args: ArgDraft[]): string | null {
  const seen = new Set<string>()
  for (const arg of args) {
    const error = argError(arg)
    if (error !== null) return error
    const key = envKey(arg.name)
    if (seen.has(key)) {
      return `duplicate argument name "${arg.name}": names are unique within a script`
    }
    seen.add(key)
  }
  return null
}

/**
 * The first error the whole authoring form would earn, or `null` when it is
 * ready to save. Mirrors the three `Store` validators in the order they run;
 * uniqueness of the script's own *name* is not mirrored — that one is a
 * `conflict` only the db can answer, so it surfaces from the failed request.
 */
export function scriptDraftError(draft: ScriptDraft): string | null {
  if (draft.name.trim() === '') return 'a script needs a name'
  if (draft.body.trim() === '') return 'a script needs a body'
  return argsError(draft.args)
}

/** True when the save button does something valid. */
export function isSavable(draft: ScriptDraft): boolean {
  return scriptDraftError(draft) === null
}

/** One drafted argument as the API's `ScriptArg`: empty optional text is
 * `null`, and `choices` is a list only for a `choice`. */
export function argFrom(draft: ArgDraft): ScriptArg {
  return {
    name: draft.name,
    label: draft.label.trim() === '' ? null : draft.label.trim(),
    kind: draft.kind,
    required: draft.required,
    default: draft.default === '' ? null : draft.default,
    choices: draft.kind === 'choice' ? parseChoices(draft.choices) : null,
  }
}

/** The create/patch body for this draft. The body is sent verbatim (it is
 * shell source — trimming it would edit the user's program); the name is
 * trimmed, exactly as `validate_script_name` stores it. */
export function scriptPayload(draft: ScriptDraft): {
  project_id: number | null
  name: string
  description: string | null
  body: string
  args: ScriptArg[]
} {
  return {
    project_id: draft.projectId === '' ? null : Number(draft.projectId),
    name: draft.name.trim(),
    description: draft.description.trim() === '' ? null : draft.description.trim(),
    body: draft.body,
    args: draft.args.map(argFrom),
  }
}

/**
 * True when the form differs from what the server last reported — i.e. the
 * save button has work to do. Compared on the *payload*, so whitespace the
 * payload would strip anyway never reads as a pending change.
 */
export function isDirty(script: Script | null, draft: ScriptDraft): boolean {
  const next = scriptPayload(draft)
  if (script === null) {
    return (
      next.name !== '' ||
      next.description !== null ||
      next.body !== '' ||
      next.project_id !== null ||
      next.args.length > 0
    )
  }
  return (
    next.name !== script.name ||
    next.description !== script.description ||
    next.body !== script.body ||
    next.project_id !== script.project_id ||
    JSON.stringify(next.args) !== JSON.stringify(script.args)
  )
}

// ---- the run form ----

/** One string per declared argument, keyed by its name. A blank entry means
 * "not supplied" — see [`valuesFor`]. */
export type ValueDraft = Record<string, string>

/** The run form as it opens: each argument pre-filled with its default. A
 * `bool` with no default starts `"false"`, since a checkbox has no third
 * state to render "absent" with. */
export function draftFrom(script: Script): ValueDraft {
  const draft: ValueDraft = {}
  for (const arg of script.args) {
    draft[arg.name] = arg.default ?? (arg.kind === 'bool' ? 'false' : '')
  }
  return draft
}

/**
 * True when this text is something Rust's `f64::from_str` accepts — the check
 * `validate_values` runs for a `number`. Spelled out rather than delegated to
 * `Number()`, which disagrees at both ends: it accepts `""` and `"0x10"` and
 * rejects `"inf"`.
 */
function parsesAsF64(raw: string): boolean {
  return /^[+-]?(inf(inity)?|nan|(\d+\.?\d*|\.\d+)(e[+-]?\d+)?)$/i.test(raw.trim())
}

/**
 * The error this value would earn from `core/scripts.rs::validate_values`, or
 * `null`.
 *
 * A blank box is "not supplied", not "the empty string": the value is then
 * omitted from the request so the declared default fills in, and an optional
 * argument with no default stays genuinely *unset* — which is the whole point
 * of the `env_remove` sweep on the run path (`${MESA_ARG_X-UNSET}` can tell
 * unset from empty). So a blank is an error only for a required argument that
 * has no default to fall back on.
 *
 * `bool` is deliberately unchecked, matching the Rust arm: the checkbox is
 * the only thing that produces the value and it produces nothing else.
 */
export function valueError(arg: ScriptArg, raw: string): string | null {
  if (raw === '') {
    return arg.required && arg.default === null
      ? `"${arg.name}" is required`
      : null
  }
  if (arg.kind === 'number' && !parsesAsF64(raw)) {
    return `"${arg.name}" must be a number`
  }
  if (arg.kind === 'choice' && !(arg.choices ?? []).includes(raw)) {
    return `"${arg.name}" must be one of ${(arg.choices ?? []).join(', ')}`
  }
  return null
}

/** True when every filled box is valid and nothing required is missing. */
export function isRunnable(args: ScriptArg[], draft: ValueDraft): boolean {
  return args.every((a) => valueError(a, draft[a.name] ?? '') === null)
}

/**
 * The `values` map to POST: the filled boxes only. Blanks are dropped rather
 * than sent as `""` so the server applies defaults and leaves the rest unset,
 * and keys the script does not declare never leave here at all — an
 * undeclared key is a `validation` error server-side, so sending one would
 * turn a stale draft into a failed run.
 */
export function valuesFor(args: ScriptArg[], draft: ValueDraft): Record<string, string> {
  const values: Record<string, string> = {}
  for (const arg of args) {
    const raw = draft[arg.name] ?? ''
    if (raw !== '') values[arg.name] = raw
  }
  return values
}
