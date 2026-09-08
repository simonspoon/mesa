import type { LibraryHookRegistration } from './types/LibraryHookRegistration'
import type { LibraryHookStatus } from './types/LibraryHookStatus'
import type { LibraryItem } from './types/LibraryItem'

/**
 * Pure decisions for the Library page's hook-registration surface (mesa task
 * 1115): whether a row offers one at all, what its badge says, what the
 * enable form refuses, and the query string an unregister is narrowed by.
 *
 * The validation here **mirrors `core::library::validate_matcher`** so the
 * form refuses exactly what the server refuses, rather than posting a value
 * only to render its 422 — the same posture `libraryDraft.ts` takes toward
 * the create/patch rules. The server is still the authority: everything here
 * is a courtesy check on the way in, and its answer is read back off the
 * status object the write returns.
 *
 * The event vocabulary is deliberately **not** here. It rides on
 * `LibraryHookStatus.events` (`core::library::HOOK_EVENTS`), so the list the
 * select offers is the list the server validates against and cannot drift
 * from it.
 */

/** The matcher a registration carries when it names no tool/source, mirroring
 * `core::library::DEFAULT_HOOK_MATCHER`. Sent as an omitted `matcher` rather
 * than this literal — the server applies it — and hidden from the badge,
 * since "every tool" is the unremarkable case. */
export const DEFAULT_HOOK_MATCHER = '*'

/** The longest matcher the server accepts, in **bytes** — mirroring
 * `core::library::HOOK_MATCHER_MAX`, which is measured against `str::len()`. */
export const HOOK_MATCHER_MAX = 200

/**
 * Whether this row offers the hooks panel: only a `hook` item has a
 * registration at all.
 *
 * An unshadowed built-in is included even though it has no numeric id and so
 * is not reachable on the route — the shipped `stop-notify` is the only hook
 * on a stock install, and gating it out hid the control on the one hook most
 * people have, with no affordance anywhere to get to a row that had it. The
 * page **forks it on the press** and opens the panel against the row that
 * creates, which is the order the rest of this surface already imposes on
 * editing a built-in.
 */
export function offersHooks(item: LibraryItem): boolean {
  return item.kind === 'hook'
}

/**
 * The ids the page reads registration status for: every **stored** hook row.
 *
 * A built-in that has not been forked yet is deliberately absent — it has no
 * id to ask about, so it carries no badge until the press that forks it. The
 * `null` case is the list before it has loaded, which is no ids rather than
 * an error.
 */
export function hookIdsFor(items: LibraryItem[] | null): number[] {
  const out: number[] = []
  for (const item of items ?? []) {
    if (offersHooks(item) && item.id !== null) out.push(item.id)
  }
  return out
}

/** How one registration reads: the event alone, or the event and the matcher
 * that narrows it. The default matcher is not shown — it says nothing. */
export function registrationLabel(reg: LibraryHookRegistration): string {
  return reg.matcher === DEFAULT_HOOK_MATCHER ? reg.event : `${reg.event} (${reg.matcher})`
}

/**
 * The registrations in display order, deduplicated.
 *
 * Ordered by the server's own event vocabulary (`status.events`) rather than
 * alphabetically, so the panel reads in the order a session fires them; an
 * event the server no longer lists sorts last rather than disappearing, since
 * a hand-edited settings file may hold one and hiding it would make it
 * unremovable from here. Ties break on matcher then command, so the list is
 * stable across polls whatever order the file happens to hold.
 *
 * The dedupe is on the whole triple: one `(event, matcher)` group may legally
 * hold this hook's command twice (a hand-edited file), and showing one row
 * for it is the honest rendering — unregistering removes every copy anyway.
 */
export function displayRegistrations(status: LibraryHookStatus): LibraryHookRegistration[] {
  const seen = new Set<string>()
  const out: LibraryHookRegistration[] = []
  for (const reg of status.registrations) {
    const key = `${reg.event} ${reg.matcher} ${reg.command}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(reg)
  }
  const rank = (event: string) => {
    const i = status.events.indexOf(event)
    return i === -1 ? status.events.length : i
  }
  return out.sort(
    (a, b) =>
      rank(a.event) - rank(b.event) ||
      a.event.localeCompare(b.event) ||
      a.matcher.localeCompare(b.matcher) ||
      a.command.localeCompare(b.command),
  )
}

/**
 * The row's badge: whether Claude Code actually runs this file, and under
 * what. Deduplicated on `(event, matcher)` — the badge answers *where* the
 * hook fires, and two commands in one group is one place.
 */
export function hookBadgeLabel(status: LibraryHookStatus): string {
  const seen = new Set<string>()
  const places: string[] = []
  for (const reg of displayRegistrations(status)) {
    const label = registrationLabel(reg)
    if (seen.has(label)) continue
    seen.add(label)
    places.push(label)
  }
  return places.length === 0 ? 'not registered' : `registered: ${places.join(', ')}`
}

/**
 * Why the server would refuse this matcher, or `null`. Judged on the trimmed
 * value, which is what `matcherPayload` actually sends: surrounding
 * whitespace in a tool-name pattern is a typo, never intent.
 */
export function matcherError(matcher: string): string | null {
  const trimmed = matcher.trim()
  // Bytes, not code units: `core::library::validate_matcher` measures
  // `str::len()`, so a non-ASCII matcher inside the limit by JavaScript's
  // count can be past it by the server's and come back a 422 the form
  // promised would not happen.
  const bytes = new TextEncoder().encode(trimmed).length
  if (bytes > HOOK_MATCHER_MAX) {
    return `matcher is ${bytes} bytes; the limit is ${HOOK_MATCHER_MAX}`
  }
  if (/[\n\r]/.test(trimmed)) {
    return 'matcher may not contain a newline'
  }
  return null
}

/** Why the enable form cannot be submitted, or `null`. An event must be
 * chosen — the picker opens on no choice rather than silently defaulting to
 * whichever event happens to be first. */
export function enableError(event: string, matcher: string): string | null {
  if (event === '') return 'choose an event'
  return matcherError(matcher)
}

/** What the register call sends as its `matcher`: the trimmed value, or
 * `undefined` for a blank one so the *server* applies its own default rather
 * than mesa's page asserting one. */
export function matcherPayload(matcher: string): string | undefined {
  const trimmed = matcher.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * The query string narrowing an unregister. Both fields are optional and an
 * omitted `event` means every registration of this hook, so an empty query is
 * the "remove all" call rather than a mistake.
 */
export function unregisterHookQuery(event?: string, matcher?: string): string {
  const parts: string[] = []
  if (event !== undefined) parts.push(`event=${encodeURIComponent(event)}`)
  if (matcher !== undefined) parts.push(`matcher=${encodeURIComponent(matcher)}`)
  return parts.length === 0 ? '' : `?${parts.join('&')}`
}
