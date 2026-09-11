import type { LibraryItem } from './types/LibraryItem'

/**
 * Pure decisions for the Settings page's list of library-prompt placeholders
 * (mesa task 1138).
 *
 * A hook template may name a library prompt as `{prompt:<name>}`, resolved
 * server-side by `core::config::Prompts` against the same view
 * `mesa library list` shows. The Settings page advertises what this install
 * actually has, so this is a projection of `GET /api/library` and never a
 * hardcoded list.
 *
 * Two rules are mirrored from `src/core/config.rs` rather than asked of the
 * server — both are pure text, and the page already holds the list:
 * - names are matched **case-insensitively**, first row in the library's own
 *   order winning (`Prompts::new`);
 * - a name holding a character no environment variable could (a library name
 *   may contain `.`) cannot be a placeholder at all, because a script reads a
 *   prompt through `MESA_PROMPT_<NAME>` (`config::prompt_env_var`). Such a row
 *   is still listed — hiding it would read as "the library lost it" — but
 *   marked unusable, which is exactly what a save would say.
 */

/** One library prompt as the hooks editor offers it. */
export type PromptPlaceholder = {
  /** The library row's own name, in its own case. */
  name: string
  /** What to type into a template: `{prompt:<name>}`. */
  placeholder: string
  /** The variable a script mode template reads it through. */
  envVar: string
  /** False when no environment variable could be named after it. */
  usable: boolean
}

/** `MESA_PROMPT_<NAME>` — uppercased, `-` folded to `_`. Mirrors
 * `config::prompt_env_var`, including the charset that makes it impossible. */
export function promptEnvVar(name: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return null
  return `MESA_PROMPT_${name.toUpperCase().replace(/-/g, '_')}`
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
    const envVar = promptEnvVar(item.name)
    rows.push({
      name: item.name,
      placeholder: `{prompt:${item.name}}`,
      envVar: envVar ?? '',
      usable: envVar !== null,
    })
  }
  return rows.sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  )
}
