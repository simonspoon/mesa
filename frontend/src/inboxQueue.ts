import type { InboxItem } from './types/InboxItem'

/**
 * Reading the whole New queue aloud (mesa task 853).
 *
 * The play button on a row reads one item; this is the run that reads all of
 * them, oldest first, starting the next as soon as one ends. The list arrives
 * newest-first (`ORDER BY i.id DESC`), so "oldest first" is a real decision the
 * page has to make rather than the order it already has — which is why it lives
 * here, next to the other inbox predicates, with a test on it.
 *
 * The run is a **snapshot**: the ids are taken at the press and never
 * recomputed. Playing an item is what marks it read, so an order derived from
 * the live list would drop each item out from under the run as it sounded, and
 * a new arrival mid-run would jump the queue it is not part of.
 */

/**
 * The items a "read all" run will speak, oldest first: everything the New view
 * holds — unread and not archived — which is the same slice `filterInbox`
 * shows and `unreadCount` counts.
 *
 * Ordered by `id` rather than `created_at`: ids are the arrival order the
 * server itself lists by, and two items sent in the same second have no other
 * tiebreak.
 */
export function readAllQueue(items: readonly InboxItem[]): number[] {
  return items
    .filter((item) => item.read_at === null && item.archived_at === null)
    .map((item) => item.id)
    .sort((a, b) => a - b)
}

/**
 * The item to read after `current`, or null when the run is over — which is
 * also the answer for an id the queue never held, so an item played on its own
 * can never restart a run that has ended.
 */
export function nextInQueue(
  queue: readonly number[],
  current: number,
): number | null {
  const at = queue.indexOf(current)
  if (at === -1) return null
  return at + 1 < queue.length ? queue[at + 1] : null
}
