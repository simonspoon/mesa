import type { InboxKind } from './types/InboxKind'

/**
 * How the Inbox shows what an item is *for* (mesa task 846).
 *
 * There are two kinds and they have two different readers: a **task summary**
 * is an agent reporting what it did, for a person to read, and a **change
 * request** asks for work, which is what `serve --watch-inbox` triages. The
 * list mixes them, so each row is tinted by kind — a colour is what makes the
 * split legible at a glance in a queue you scroll.
 *
 * The mapping lives here rather than inline in `InboxView` for the reason every
 * other pure module in this folder exists: a class name built from a value is
 * exactly the kind of expression that silently produces `inbox-kind-undefined`
 * for a value nobody thought about, and a test is cheaper than noticing the
 * tint is missing.
 */

/**
 * The two kinds and their wording. There is no compose form any more (mesa task
 * 847 — items are sent by agents, naming the task they came from), so this list
 * exists purely to word and tint what arrives.
 */
export const INBOX_KINDS: readonly { kind: InboxKind; label: string }[] = [
  { kind: 'change-request', label: 'change request' },
  { kind: 'task-summary', label: 'task summary' },
]

/** Human wording for one kind, for the row's meta line. */
export function inboxKindLabel(kind: InboxKind): string {
  return INBOX_KINDS.find((k) => k.kind === kind)?.label ?? kind
}

/**
 * The tint class for one row. One class per kind — the colours themselves live
 * in `App.css`, so light and dark are its problem, not this module's.
 *
 * The label above rides in the meta line as well: a tint alone is not something
 * every reader can see, and the two kinds are three seconds of the reader's
 * attention apart (one is a report, the other is work being asked for).
 */
export function inboxKindClass(kind: InboxKind): string {
  return `inbox-kind-${kind}`
}
