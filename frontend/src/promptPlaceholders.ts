import type { LibraryItem } from './types/LibraryItem'

/**
 * Pure decisions for the Settings page's list of library-prompt placeholders
 * (mesa task 1138).
 *
 * A hook may name a library prompt as `{prompt:<name>}`, resolved server-side
 * by `core::config::Prompts` against the same view `mesa library list` shows.
 * The Settings page advertises what this install actually has, so this is a
 * projection of `GET /api/library` and never a hardcoded list.
 *
 * One rule is mirrored from `src/core/config.rs` rather than asked of the
 * server — it is pure text, and the page already holds the list: names are
 * matched **case-insensitively**, first row in the library's own order winning
 * (`Prompts::new`). Any library name is usable (mesa task 1143 — the body is
 * quoted into the script like every other value, so nothing else has to be
 * able to hold the name).
 */

/** One library prompt as the hooks editor offers it. */
export type PromptPlaceholder = {
  /** The library row's own name, in its own case. */
  name: string
  /** What to type into a template: `{prompt:<name>}`. */
  placeholder: string
}

/** What to type into a hook template to splice this prompt in — the one
 * spelling, shared by the Settings list and the Library row (mesa task 1139),
 * so the two can never advertise different forms. */
export function promptPlaceholder(name: string): string {
  return `{prompt:${name}}`
}

/**
 * The prompts `items` offers as placeholders, sorted by name
 * case-insensitively and deduplicated the way the server resolves them.
 */
export function promptPlaceholders(items: LibraryItem[]): PromptPlaceholder[] {
  const seen = new Set<string>()
  const rows: PromptPlaceholder[] = []
  for (const item of items) {
    if (item.kind !== 'prompt') continue
    const key = item.name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    rows.push({ name: item.name, placeholder: promptPlaceholder(item.name) })
  }
  return rows.sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  )
}
