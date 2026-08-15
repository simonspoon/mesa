import type { ConfigLive } from './types/ConfigLive'

/**
 * Pure draft logic for the Settings page's live-prompt editor (mesa task 867),
 * hoisted out of the component so it is unit-testable (see CLAUDE.md: the
 * frontend tests cover the pure modules, never a rendered tree).
 *
 * The same rule [`speechDraft`](./speechDraft.ts) models, for the one value
 * this section edits:
 *
 * - **Blank means "the block mesa ships"**, not "no instructions". A blank box
 *   is PUT as `null`, which removes the key so the built-in prompt applies —
 *   an agent spawned with an empty prompt is the one outcome this must never
 *   produce.
 * - **A configured prompt replaces the built-in**, so what the box holds is
 *   the whole of what mesa sends: editing starts from the built-in text rather
 *   than adding to it.
 */

/** The section's boxes as typed — today, exactly one. */
export type LivePromptDraft = { prompt: string }

/** How long a prompt may be, in bytes — `core::config::MAX_LIVE_PROMPT`. */
export const MAX_LIVE_PROMPT = 16 * 1024

/** The editable text as loaded: an unconfigured prompt is blank. */
export function draftFrom(live: ConfigLive): LivePromptDraft {
  return { prompt: live.prompt ?? '' }
}

/**
 * True while the box is blank, i.e. the built-in block is what applies — which
 * is what the section shows as the textarea's placeholder, and what makes
 * *start from the built-in prompt* the useful control rather than a no-op.
 */
export function usesDefault(draft: LivePromptDraft): boolean {
  return (draft.prompt ?? '').trim() === ''
}

/**
 * The complaint about the prompt box, or `null` if it is fine. Blank is *not*
 * an error — it is the legitimate "use the block mesa ships", the reset.
 *
 * Mirrors the server's one rule (`core::config::validate_live_prompt`): a
 * length bound, measured in bytes as the server measures it, so a prompt full
 * of non-ASCII is refused here for the same reason it would be there.
 */
export function valueError(text: string): string | null {
  const trimmed = (text ?? '').trim()
  if (trimmed === '') return null
  const bytes = new TextEncoder().encode(trimmed).length
  if (bytes > MAX_LIVE_PROMPT) {
    return `${bytes} bytes; the limit is ${MAX_LIVE_PROMPT}`
  }
  return null
}

/** What the box means: a prompt, or `null` for "the block mesa ships". */
function valueOf(draft: LivePromptDraft): string | null {
  const trimmed = (draft.prompt ?? '').trim()
  return trimmed === '' ? null : trimmed
}

/** True when the box differs from what the server last reported. */
export function isDirty(live: ConfigLive, draft: LivePromptDraft): boolean {
  return valueOf(draft) !== (live.prompt ?? null)
}

/** True when nothing drafted would be rejected by the server. */
export function isSavable(draft: LivePromptDraft): boolean {
  return valueError(draft.prompt ?? '') === null
}

/**
 * The subset to PUT: the key only when it actually changed, so the API's "only
 * the keys present are touched" rule keeps two editors from clobbering each
 * other. A box cleared to blank sends `null` — the server's "remove this key",
 * which is the reset to the built-in block.
 */
export function changedLive(
  live: ConfigLive,
  draft: LivePromptDraft,
): Record<string, string | null> {
  if (!isDirty(live, draft) || !isSavable(draft)) return {}
  return { prompt: valueOf(draft) }
}
