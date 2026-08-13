import type { InboxItem } from './types/InboxItem'

/**
 * Read/unread for the inbox (mesa task 831).
 *
 * An item is **unread** until `read_at` is stamped, and it is stamped by the
 * page rather than by the server: the two things that count as having read an
 * item are holding it open long enough to take it in, and hearing it through
 * the play button. Both are facts only the browser knows, which is why the
 * route (`POST /api/inbox/{id}/read`) is idempotent — the page may fire it
 * without tracking whether it already has.
 *
 * The decision lives here rather than inline in `InboxView` because it is the
 * kind of predicate the list's own 3s poll can make wrong: `read_at` does not
 * change until the next fetch lands, so "already sent" is a separate fact from
 * "already read" and both have to be checked.
 */

/**
 * How long an item must stay open before it counts as read. A few seconds:
 * long enough that opening the wrong item and closing it again does not mark
 * it, short enough that actually reading it always does. Deliberately close to
 * the list's own poll interval in size but unrelated to it — the dwell timer
 * is never restarted by a poll (see `InboxView`), or a refetch landing mid-
 * dwell would push the mark out forever.
 */
export const READ_DWELL_MS = 3000

/**
 * How many items are still unread — the nav badge's count. Null (nothing
 * fetched yet) is zero: a badge that has not loaded shows nothing rather than
 * a number it would have to correct.
 *
 * An **archived** item is never counted (mesa task 845), unread or not:
 * archiving is how an item leaves the queue without being triaged, so a badge
 * that kept counting it would be a number no amount of archiving could clear —
 * exactly the bug task 831 fixed by counting unread rather than everything.
 * It is also the count for the "New" sub-view, which is what the badge sits on.
 */
export function unreadCount(items: readonly InboxItem[] | null): number {
  if (!items) return 0
  return items.filter(
    (item) => item.read_at === null && item.archived_at === null,
  ).length
}

/**
 * Whether marking this item read is worth a request: it is still listed, still
 * unread, and this page has not already sent the mark for it. The last check
 * is what stops the two triggers (dwell, playback) — and the re-renders the
 * poll causes between the POST and the refetch that reflects it — from sending
 * the same no-op write again.
 */
export function needsMarkRead(
  items: readonly InboxItem[] | null,
  id: number,
  sent: ReadonlySet<number>,
): boolean {
  if (sent.has(id)) return false
  const item = items?.find((it) => it.id === id)
  return item !== undefined && item.read_at === null
}
