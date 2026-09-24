import type { LiveNotebookEntry } from './types/LiveNotebookEntry'

/**
 * Pure logic for the Settings page's Memory tab (mesa task 1147) — the live
 * notebook, the bullets earlier conversations left for later ones, every
 * active one riding in every live agent's prompt. Hoisted out of the
 * component so it is unit-testable (CLAUDE.md: the frontend tests cover the
 * pure modules, never a rendered tree).
 *
 * The three numbers mirror `core::live`'s constants. The server owns the
 * rules (a 422 names the numbers); this module only lets the page refuse the
 * obvious before the round trip and draw the meter.
 */

/** `core::live::LIVE_NOTEBOOK_BUDGET_WORDS`. */
export const NOTEBOOK_BUDGET_WORDS = 500
/** `core::live::LIVE_NOTEBOOK_ENTRY_MAX`, in characters. */
export const NOTEBOOK_ENTRY_MAX = 600

/** Whitespace-separated tokens — the same rule `core::live::word_count`
 *  applies, so the meter agrees with the server's verdict. */
export function wordCount(text: string): number {
  const trimmed = text.trim()
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length
}

/** The active notebook's total words — what the budget is judged on. */
export function notebookWords(entries: readonly LiveNotebookEntry[]): number {
  return entries.reduce((sum, e) => sum + wordCount(e.body), 0)
}

/** The running meter, e.g. `120 / 500 words`. */
export function budgetMeter(words: number): string {
  return `${words} / ${NOTEBOOK_BUDGET_WORDS} words`
}

/** Whether a notebook of `words` words is past the budget (strict). Display
 *  only: the server no longer refuses a write past the budget (mesa task
 *  1337) — the tidy pass between conversations brings it back within it. */
export function overBudget(words: number): boolean {
  return words > NOTEBOOK_BUDGET_WORDS
}

/** One entry's provenance line: id, the date it was added, which
 *  conversation wrote it and which last relied on it. */
export function metaLine(entry: LiveNotebookEntry): string {
  const added = entry.created_at.slice(0, 10)
  const from =
    entry.source_session_id === null ? '-' : String(entry.source_session_id)
  const used =
    entry.last_used_session_id === null
      ? '-'
      : String(entry.last_used_session_id)
  return `#${entry.id} · added ${added} · from session ${from} · last used session ${used}`
}

/** Whether a typed body is worth sending: non-blank and within the entry
 *  length. The removal guard is the server's — a 422 comes
 *  back inline. */
export function isSendable(body: string): boolean {
  const trimmed = body.trim()
  return trimmed !== '' && trimmed.length <= NOTEBOOK_ENTRY_MAX
}

/** The complaint about a typed body, or `null` if it is fine. Blank is not
 *  an error while typing — it is just not sendable yet. */
export function bodyError(body: string): string | null {
  const trimmed = body.trim()
  if (trimmed.length > NOTEBOOK_ENTRY_MAX) {
    return `an entry must be at most ${NOTEBOOK_ENTRY_MAX} characters (${trimmed.length})`
  }
  return null
}
