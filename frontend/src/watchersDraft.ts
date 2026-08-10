import type { ConfigWatchers } from './types/ConfigWatchers'

/**
 * Pure draft logic for the Settings page's watcher editor, hoisted out of the
 * component so it is unit-testable (see CLAUDE.md: the frontend tests cover the
 * pure modules, never a rendered tree).
 *
 * The same two things [`pricingDraft`](./pricingDraft.ts) models, for the one
 * value this section edits:
 *
 * - **Blank means "use the built-in default"**, exactly as a blank command box
 *   means "use the built-in template". A blank box is PUT as `null`, which
 *   removes the key and restores the limit mesa ships.
 * - **The limit is edited as text, not as a number.** A half-typed `""` or
 *   `"1"` has to survive a keystroke, so the draft holds a string and only
 *   `changedWatchers` converts — parsing per render would clobber typing.
 */

/** The accepted range, mirroring the server's rule so both name one bound. */
export const MIN_CONCURRENCY = 1
export const MAX_CONCURRENCY = 20

/** The section's boxes as typed — today, exactly one. */
export type WatchersDraft = { todo_concurrency: string }

/** The editable text as loaded: an unconfigured value is blank. */
export function draftFrom(watchers: ConfigWatchers): WatchersDraft {
  const value = watchers.todo_concurrency
  return { todo_concurrency: value === null ? '' : String(value) }
}

/**
 * The complaint about the concurrency box, or `null` if it is fine. Blank is
 * *not* an error — it is the legitimate "use the default", the reset.
 */
export function valueError(text: string): string | null {
  const trimmed = (text ?? '').trim()
  if (trimmed === '') return null
  // Deliberately stricter than `Number`, which happily accepts "2.5", "1e3"
  // and "0x2" — the server takes a whole number and nothing else.
  if (!/^-?\d+$/.test(trimmed)) return 'not a whole number'
  const n = Number(trimmed)
  if (n < MIN_CONCURRENCY || n > MAX_CONCURRENCY) {
    return `must be between ${MIN_CONCURRENCY} and ${MAX_CONCURRENCY}`
  }
  return null
}

/** What the box means: a number, or `null` for "the built-in default". */
function valueOf(draft: WatchersDraft): number | null {
  const trimmed = (draft.todo_concurrency ?? '').trim()
  return trimmed === '' ? null : Number(trimmed)
}

/** True when the box differs from what the server last reported. */
export function isDirty(
  watchers: ConfigWatchers,
  draft: WatchersDraft,
): boolean {
  if (valueError(draft.todo_concurrency ?? '')) return true
  return valueOf(draft) !== watchers.todo_concurrency
}

/** True when nothing drafted would be rejected by the server. */
export function isSavable(draft: WatchersDraft): boolean {
  return valueError(draft.todo_concurrency ?? '') === null
}

/**
 * The subset to PUT: the key only when it actually changed, so the API's "only
 * the keys present are touched" rule keeps two editors from clobbering each
 * other. A box cleared to blank sends `null` — the server's "remove this key",
 * which is the reset to the built-in limit.
 */
export function changedWatchers(
  watchers: ConfigWatchers,
  draft: WatchersDraft,
): Record<string, number | null> {
  if (!isDirty(watchers, draft) || !isSavable(draft)) return {}
  return { todo_concurrency: valueOf(draft) }
}
