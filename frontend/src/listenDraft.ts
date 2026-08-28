import type { ConfigListen } from './types/ConfigListen'

/**
 * Pure draft logic for the Settings page's listen editor (mesa task 955),
 * hoisted out of the component so it is unit-testable (see CLAUDE.md: the
 * frontend tests cover the pure modules, never a rendered tree).
 *
 * The input-side mirror of [`speechDraft`](./speechDraft.ts), for the one
 * value this section edits — the model `live transcribe` runs the external
 * `auris` binary with:
 *
 * - **Blank means "the binary's own default"**, not "silence". A blank box
 *   is PUT as `null`, which removes the key so mesa passes no `-m` at all.
 * - **The model is edited as text**, even when the box is a `<select>`: an
 *   installed binary mesa could not ask has no list to pick from, and the
 *   value already in the file has to survive that.
 */

/** The section's boxes as typed — today, exactly one. */
export type ListenDraft = { model: string }

/** The editable text as loaded: an unconfigured model is blank. */
export function draftFrom(listen: ConfigListen): ListenDraft {
  return { model: listen.model ?? '' }
}

/**
 * Whether the picker can be a list: only when the binary answered
 * `--list-models` with something. Empty means mesa could not ask, and the box
 * has to accept a typed name instead — never that there are no models.
 */
export function canPick(listen: ConfigListen): boolean {
  return listen.models.length > 0
}

/**
 * The options to offer, in the binary's own order, with the configured model
 * included even when the binary no longer lists it — otherwise selecting the
 * list would silently rewrite a value the user never touched.
 */
export function options(listen: ConfigListen): string[] {
  const configured = (listen.model ?? '').trim()
  if (configured === '' || listen.models.includes(configured)) return listen.models
  return [...listen.models, configured]
}

/**
 * The complaint about the model box, or `null` if it is fine. Blank is *not*
 * an error — it is the legitimate "use the binary's default", the reset.
 *
 * Mirrors the server's shape rule (`core::listen::is_model_name`) so a name
 * that could be read as an option is refused before the round trip. One
 * character wider than the voice rule — a dot is allowed, since a real model
 * name looks like `parakeet-tdt-0.6b-v2-int8`. Membership in the offered list
 * is deliberately **not** checked here: the server owns that, and it skips it
 * too when it has no list.
 */
export function valueError(text: string): string | null {
  const trimmed = (text ?? '').trim()
  if (trimmed === '') return null
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(trimmed)) {
    return 'letters, digits, underscores, dots and dashes only'
  }
  if (trimmed.length > 64) return 'longer than 64 characters'
  return null
}

/** What the box means: a model, or `null` for "the binary's default". */
function valueOf(draft: ListenDraft): string | null {
  const trimmed = (draft.model ?? '').trim()
  return trimmed === '' ? null : trimmed
}

/** True when the box differs from what the server last reported. */
export function isDirty(listen: ConfigListen, draft: ListenDraft): boolean {
  return valueOf(draft) !== (listen.model ?? null)
}

/** True when nothing drafted would be rejected by the server. */
export function isSavable(draft: ListenDraft): boolean {
  return valueError(draft.model ?? '') === null
}

/**
 * The subset to PUT: the key only when it actually changed, so the API's
 * "only the keys present are touched" rule keeps two editors from clobbering
 * each other. A box cleared to blank sends `null` — the server's "remove this
 * key", which is the reset to the binary's own model.
 */
export function changedListen(
  listen: ConfigListen,
  draft: ListenDraft,
): Record<string, string | null> {
  if (!isDirty(listen, draft) || !isSavable(draft)) return {}
  return { model: valueOf(draft) }
}
