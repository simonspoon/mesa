import type { InboxItem } from './types/InboxItem'

/**
 * The Inbox's three sub-views (mesa task 845) — "New", "Read" and "Archived",
 * the sub-links under Inbox in the nav. They are a *filter over one list*, not
 * three lists: the page fetches the whole inbox exactly as it always has and
 * shows the slice the URL names, so the poll, the read marks and playback are
 * untouched by which one is open.
 *
 * The predicates live here rather than inline in `InboxView` for the reason
 * every other pure module in this folder exists: they are the kind of
 * condition that is quietly wrong (an archived item showing up in New as well)
 * and cheap to pin with a test.
 */

/** Which slice of the inbox is being shown. */
export type InboxFilter = 'new' | 'read' | 'archived'

/**
 * The sub-links, in nav order. `new` is the plain `#/inbox` URL: it is the
 * triage queue, so the Inbox link itself must keep landing there rather than
 * on a fourth "everything" view nobody asked for.
 */
export const INBOX_SUBNAV: readonly {
  filter: InboxFilter
  label: string
  hash: string
}[] = [
  { filter: 'new', label: 'New', hash: '#/inbox' },
  { filter: 'read', label: 'Read', hash: '#/inbox/read' },
  { filter: 'archived', label: 'Archived', hash: '#/inbox/archived' },
]

/**
 * The filter a matched `#/inbox[/<segment>]` route names. An absent segment is
 * `new` — see `INBOX_SUBNAV`. The segment is only ever `read` or `archived`,
 * because the route pattern in `App` matches nothing else; anything unexpected
 * falls back to the triage queue rather than showing an empty page.
 */
export function inboxFilterFor(segment: string | undefined): InboxFilter {
  return segment === 'read' || segment === 'archived' ? segment : 'new'
}

/**
 * The items belonging in one sub-view.
 *
 * Archiving outranks reading: an archived item is in Archived and nowhere
 * else, read or not. Filing an item away is a decision about where it lives,
 * so leaving it in New too would make archiving useless for the one thing it
 * is for — getting an item out of the queue without triaging or destroying it.
 *
 * `keep` holds the items the reader is currently engaged with — open, or being
 * read aloud — and they stay on whichever view they were opened from even once
 * they no longer belong on it. Both of those *are* what marks an item read, so
 * without this the "New" view would drop an item out from under the person
 * reading it three seconds after they opened it, taking the stop button for
 * the audio still playing with it. Closing the item is what lets it go.
 */
export function filterInbox(
  items: readonly InboxItem[],
  filter: InboxFilter,
  keep: ReadonlySet<number> = new Set(),
): InboxItem[] {
  return items.filter((item) =>
    keep.has(item.id)
      ? true
      : filter === 'archived'
        ? item.archived_at !== null
        : item.archived_at === null &&
          (filter === 'read' ? item.read_at !== null : item.read_at === null),
  )
}
