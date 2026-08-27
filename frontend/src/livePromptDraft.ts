import type { ConfigLive } from './types/ConfigLive'

/**
 * Pure draft logic for the Settings page's live-conversation editor (mesa
 * task 886), hoisted out of the component so it is unit-testable (see
 * CLAUDE.md: the frontend tests cover the pure modules, never a rendered
 * tree).
 *
 * This module used to own two boxes — the agent's prompt and the auto-send
 * wait (mesa task 867) — but the prompt moved to the library as of mesa task
 * 919: it is now the `live-agent-prompt` library item, edited on `#/library`
 * like any other row. This module keeps its name and its one remaining job:
 * the wait box, using the same rule [`speechDraft`](./speechDraft.ts) and
 * [`watchersDraft`](./watchersDraft.ts) model —
 *
 * - **Blank means "what mesa ships"**, never "nothing". A blank box is PUT as
 *   `null`, which removes the key.
 * - **The wait is edited as text, not as a number** (`watchersDraft`'s rule):
 *   a half-typed `""` or `"3"` has to survive a keystroke, so the draft holds
 *   a string and only [`changedLive`] converts.
 */

/** The section's one box as typed: the auto-send wait. */
export type LivePromptDraft = { auto_send_ms: string }

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
    auto_send_ms:
      live.auto_send_ms === null ? '' : String(live.auto_send_ms),
  }
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

/** What the wait box means: a number, or `null` for "the wait mesa ships". */
function waitOf(draft: LivePromptDraft): number | null {
  const trimmed = (draft.auto_send_ms ?? '').trim()
  return trimmed === '' ? null : Number(trimmed)
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

/** True when the box differs from what the server last reported. */
export function isDirty(live: ConfigLive, draft: LivePromptDraft): boolean {
  return isWaitDirty(live, draft)
}

/** True when nothing drafted would be rejected by the server. */
export function isSavable(draft: LivePromptDraft): boolean {
  return waitError(draft.auto_send_ms ?? '') === null
}

/**
 * The subset to PUT: the key only when it actually changed, so the API's
 * "only the keys present are touched" rule keeps two editors from clobbering
 * each other. A box cleared to blank sends `null` — the server's "remove this
 * key", which is the reset to what mesa ships.
 */
export function changedLive(
  live: ConfigLive,
  draft: LivePromptDraft,
): Record<string, number | null> {
  if (!isSavable(draft)) return {}
  const changed: Record<string, number | null> = {}
  if (isWaitDirty(live, draft)) changed.auto_send_ms = waitOf(draft)
  return changed
}
