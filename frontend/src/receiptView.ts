// Pure, side-effect-free view logic for a task's work receipt (task 920).
// Lives here rather than inline in TaskPanel.tsx per CLAUDE.md's frontend
// invariant: predicates/formatters worth testing belong in a *.ts module
// with a vitest test, not inline in a component.

import type { DiffStat } from './types/DiffStat'
import type { TaskReceipt } from './types/TaskReceipt'

/**
 * A compact human line for a diff stat, e.g. "3 files · +42 −7". The zero
 * case ("no file changes") is a legitimate, expected outcome — a receipt can
 * record zero commits — not something to dress up as an error.
 */
export function summarizeStat(stat: DiffStat): string {
  if (stat.files_changed === 0) return 'no file changes'
  const files = stat.files_changed === 1 ? '1 file' : `${stat.files_changed} files`
  return `${files} · +${stat.insertions} −${stat.deletions}`
}

/**
 * True when the receipt recorded no commits at all — a legitimate outcome
 * (nothing was committed during the claim window), not a failure. Callers
 * use this to render "no commits in the claim window" rather than treating
 * an empty receipt as broken.
 */
export function receiptIsEmpty(r: TaskReceipt): boolean {
  return r.commits.length === 0
}

/**
 * A short label for the receipt's transcript link, or `null` when there is
 * none to show. Spec D5: `owner` frequently does not resolve to a
 * `cc_sessions` UUID (e.g. the `session_XXX` convention execute-todo uses),
 * so a missing transcript is the common, legitimate case — this must never
 * be rendered as an error, only omitted.
 */
export function transcriptLabel(r: TaskReceipt): string | null {
  if (r.transcript_path === null) return null
  return r.session_id ?? r.transcript_path
}
