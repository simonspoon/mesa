import type { ConfigSpeech } from './types/ConfigSpeech'

/**
 * Pure draft logic for the Settings page's speech editor (mesa task 822),
 * hoisted out of the component so it is unit-testable (see CLAUDE.md: the
 * frontend tests cover the pure modules, never a rendered tree).
 *
 * The same rule [`watchersDraft`](./watchersDraft.ts) models, for the one value
 * this section edits:
 *
 * - **Blank means "the synthesiser's own default"**, not "silence". A blank box
 *   is PUT as `null`, which removes the key so mesa passes no `-v` at all.
 * - **The voice is edited as text**, even when the box is a `<select>`: an
 *   installed binary mesa could not ask has no list to pick from, and the value
 *   already in the file has to survive that.
 */

/** The section's boxes as typed — today, exactly one. */
export type SpeechDraft = { voice: string }

/** The editable text as loaded: an unconfigured voice is blank. */
export function draftFrom(speech: ConfigSpeech): SpeechDraft {
  return { voice: speech.voice ?? '' }
}

/**
 * Whether the picker can be a list: only when the binary answered
 * `--list-voices` with something. Empty means mesa could not ask, and the box
 * has to accept a typed name instead — never that there are no voices.
 */
export function canPick(speech: ConfigSpeech): boolean {
  return speech.voices.length > 0
}

/**
 * The options to offer, in the binary's own order, with the configured voice
 * included even when the binary no longer lists it — otherwise selecting the
 * list would silently rewrite a value the user never touched.
 */
export function options(speech: ConfigSpeech): string[] {
  const configured = (speech.voice ?? '').trim()
  if (configured === '' || speech.voices.includes(configured)) return speech.voices
  return [...speech.voices, configured]
}

/**
 * The complaint about the voice box, or `null` if it is fine. Blank is *not* an
 * error — it is the legitimate "use the binary's default", the reset.
 *
 * Mirrors the server's shape rule (`core::speech::is_voice_name`) so a name
 * that could be read as an option is refused before the round trip. Membership
 * in the offered list is deliberately **not** checked here: the server owns
 * that, and it skips it too when it has no list.
 */
export function valueError(text: string): string | null {
  const trimmed = (text ?? '').trim()
  if (trimmed === '') return null
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(trimmed)) {
    return 'letters, digits, underscores and dashes only'
  }
  if (trimmed.length > 64) return 'longer than 64 characters'
  return null
}

/** What the box means: a voice, or `null` for "the binary's default". */
function valueOf(draft: SpeechDraft): string | null {
  const trimmed = (draft.voice ?? '').trim()
  return trimmed === '' ? null : trimmed
}

/** True when the box differs from what the server last reported. */
export function isDirty(speech: ConfigSpeech, draft: SpeechDraft): boolean {
  return valueOf(draft) !== (speech.voice ?? null)
}

/** True when nothing drafted would be rejected by the server. */
export function isSavable(draft: SpeechDraft): boolean {
  return valueError(draft.voice ?? '') === null
}

/**
 * The subset to PUT: the key only when it actually changed, so the API's "only
 * the keys present are touched" rule keeps two editors from clobbering each
 * other. A box cleared to blank sends `null` — the server's "remove this key",
 * which is the reset to the binary's own voice.
 */
export function changedSpeech(
  speech: ConfigSpeech,
  draft: SpeechDraft,
): Record<string, string | null> {
  if (!isDirty(speech, draft) || !isSavable(draft)) return {}
  return { voice: valueOf(draft) }
}
