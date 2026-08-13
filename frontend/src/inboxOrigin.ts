import type { InboxItem } from './types/InboxItem'

/**
 * The **first line of an inbox item**: which project, and which piece of work,
 * the item is about (mesa task 847).
 *
 * An item now names the task it came from, and the server derives that task's
 * name and its project's name on every read — so the row can say what a report
 * is about without the sender having had to type it into the body. That is the
 * whole reason `task_id` is required at creation.
 *
 * Both derived fields are null together (a row that predates 847, or one whose
 * origin task was later deleted — the FK is `ON DELETE SET NULL`), and the
 * *server* is the only thing that decides that, so this module answers `null`
 * for the whole line rather than inventing a half of it. A row with no origin
 * simply shows none: an empty heading, or one reading "· something", would be
 * worse than the item it sits above.
 */
export function inboxOriginLabel(item: InboxItem): string | null {
  const parts = [item.project_name, item.task_name].filter(
    (p): p is string => p !== null && p !== '',
  )
  return parts.length === 0 ? null : parts.join(' · ')
}
