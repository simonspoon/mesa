import type { InboxItem } from './types/InboxItem'

/**
 * The **archive line** of an inbox item: how it was disposed of, why, and —
 * since mesa task 1269 — which task it became.
 *
 * The Archived view is where a reader asks "why is this here", and assigning an
 * item now archives it as `converted-to-task` with a pointer to the task it
 * turned into instead of deleting it, so that view has a third thing to say and
 * a link to offer. Any of the three parts may be absent — an item archived with
 * no verdict at all, an old row with a reason and no outcome, a converted one
 * with no prose (assign writes none) — so the decision of whether there is a
 * line at all, and which pieces it holds, lives here rather than as three
 * nested ternaries in the view.
 *
 * `null` means there is nothing to say and the line is not rendered: a blank
 * muted row under every live item would read as a missing value.
 */
export type InboxArchiveLine = {
  /** The enumerated outcome, already readable as it stands, or null. */
  outcome: string | null
  /** The archiver's prose verdict, or null. */
  reason: string | null
  /** The task this item became, or null if it was not converted. */
  convertedTaskId: number | null
}

export function inboxArchiveLine(item: InboxItem): InboxArchiveLine | null {
  const line = {
    outcome: item.archive_outcome,
    reason: item.archive_reason,
    convertedTaskId: item.converted_task_id,
  }
  return line.outcome === null &&
    line.reason === null &&
    line.convertedTaskId === null
    ? null
    : line
}
