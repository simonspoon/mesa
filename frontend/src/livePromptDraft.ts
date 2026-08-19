import type { ConfigLive } from './types/ConfigLive'

/**
 * Pure draft logic for the Settings page's live-conversation editor (mesa tasks
 * 867 and 886), hoisted out of the component so it is unit-testable (see
 * CLAUDE.md: the frontend tests cover the pure modules, never a rendered tree).
 *
 * The same rule [`speechDraft`](./speechDraft.ts) models, for each value this
 * section edits:
 *
 * - **Blank means "what mesa ships"**, never "nothing". A blank box is PUT as
 *   `null`, which removes the key — an agent spawned with an empty prompt is
 *   the one outcome this must never produce, and a wait of zero would post a
 *   word at a time.
 * - **A configured prompt replaces the built-in**, so what the box holds is
 *   the whole of what mesa sends: editing starts from the built-in text rather
 *   than adding to it.
 * - **The wait is edited as text, not as a number** ([`watchersDraft`](./watchersDraft.ts)'s
 *   rule): a half-typed `""` or `"3"` has to survive a keystroke, so the draft
 *   holds a string and only [`changedLive`] converts.
 */

/** The section's boxes as typed: the agent's prompt, and the auto-send wait. */
export type LivePromptDraft = { prompt: string; auto_send_ms: string }

/** How long a prompt may be, in bytes — `core::config::MAX_LIVE_PROMPT`. */
export const MAX_LIVE_PROMPT = 16 * 1024

/**
 * The wait's accepted range in milliseconds, mirroring the server's rule
 * (`core::config::MIN_LIVE_AUTO_SEND_MS`/`MAX_LIVE_AUTO_SEND_MS`) so both ends
 * name one bound.
 */
export const MIN_AUTO_SEND_MS = 250
export const MAX_AUTO_SEND_MS = 60_000

/** The editable text as loaded: an unconfigured value is blank. */
export function draftFrom(live: ConfigLive): LivePromptDraft {
  return {
    prompt: live.prompt ?? '',
    auto_send_ms:
      live.auto_send_ms === null ? '' : String(live.auto_send_ms),
  }
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

/**
 * The complaint about the wait box, or `null` if it is fine. Blank is *not* an
 * error — it is the legitimate "use the wait mesa ships", the reset.
 *
 * Mirrors the server's rule: a whole number of milliseconds inside the bounds.
 * Deliberately stricter than `Number`, which happily accepts `"2.5"`, `"1e3"`
 * and `"0x2"`.
 */
export function waitError(text: string): string | null {
  const trimmed = (text ?? '').trim()
  if (trimmed === '') return null
  if (!/^-?\d+$/.test(trimmed)) return 'not a whole number of milliseconds'
  const ms = Number(trimmed)
  if (ms < MIN_AUTO_SEND_MS || ms > MAX_AUTO_SEND_MS) {
    return `must be between ${MIN_AUTO_SEND_MS} and ${MAX_AUTO_SEND_MS} milliseconds`
  }
  return null
}

/** What the prompt box means: a prompt, or `null` for "the block mesa ships". */
function valueOf(draft: LivePromptDraft): string | null {
  const trimmed = (draft.prompt ?? '').trim()
  return trimmed === '' ? null : trimmed
}

/** What the wait box means: a number, or `null` for "the wait mesa ships". */
function waitOf(draft: LivePromptDraft): number | null {
  const trimmed = (draft.auto_send_ms ?? '').trim()
  return trimmed === '' ? null : Number(trimmed)
}

/** True when the prompt box differs from what the server last reported. */
function isPromptDirty(live: ConfigLive, draft: LivePromptDraft): boolean {
  return valueOf(draft) !== (live.prompt ?? null)
}

/**
 * True when the wait box differs from what the server last reported. A box
 * holding something the server would refuse counts as dirty, so the page says
 * "unsaved changes" rather than pretending a typo is the stored value.
 */
function isWaitDirty(live: ConfigLive, draft: LivePromptDraft): boolean {
  if (waitError(draft.auto_send_ms ?? '')) return true
  return waitOf(draft) !== live.auto_send_ms
}

/** True when either box differs from what the server last reported. */
export function isDirty(live: ConfigLive, draft: LivePromptDraft): boolean {
  return isPromptDirty(live, draft) || isWaitDirty(live, draft)
}

/** True when nothing drafted would be rejected by the server. */
export function isSavable(draft: LivePromptDraft): boolean {
  return (
    valueError(draft.prompt ?? '') === null &&
    waitError(draft.auto_send_ms ?? '') === null
  )
}

/**
 * The subset to PUT: each key only when it actually changed, so the API's "only
 * the keys present are touched" rule keeps two editors from clobbering each
 * other. A box cleared to blank sends `null` — the server's "remove this key",
 * which is the reset to what mesa ships.
 */
export function changedLive(
  live: ConfigLive,
  draft: LivePromptDraft,
): Record<string, string | number | null> {
  if (!isSavable(draft)) return {}
  const changed: Record<string, string | number | null> = {}
  if (isPromptDirty(live, draft)) changed.prompt = valueOf(draft)
  if (isWaitDirty(live, draft)) changed.auto_send_ms = waitOf(draft)
  return changed
}
