/**
 * Naming a new file in the Files tab (mesa task 672): the one decision the
 * create affordance makes before it touches the network — does this typed name
 * become a relative path, or an inline message?
 *
 * A pure module rather than a handful of `if`s inside `FilesView.tsx`, for the
 * same reason `navOrder`/`fileTabs` are (CLAUDE.md): this is exactly the kind
 * of predicate that ships wrong, and a component isn't where it can be tested.
 *
 * The rules mirror `core::files::create_file`'s single-component checks, but
 * the SERVER stays authoritative — this copy exists to turn an obviously bad
 * name into an instant message instead of a round trip, never to be the
 * boundary. Anything it lets through the server still re-validates.
 */

/** Either the relative path to POST, or why nothing will be sent. */
export type NewFileName =
  | { ok: true; path: string }
  | { ok: false; reason: string }

/**
 * Joins `parent` (a directory's relative path from the tree, `''` for the
 * project root) and the typed `name` into the path
 * `POST /files/content` takes.
 *
 * `name` is trimmed first — the same trim the server applies, so what is sent
 * is what will be created. An empty result, `.`/`..`, and any `/`, `\` or NUL
 * are rejected: they are the ways a single name stops being a single name, and
 * the reason `parent.join(name)` provably stays inside `parent`. A leading dot
 * is fine (`.env` is a file, not a traversal).
 */
export function newFilePath(parent: string, name: string): NewFileName {
  const trimmed = name.trim()
  if (trimmed === '') return { ok: false, reason: 'Enter a file name.' }
  if (trimmed === '.' || trimmed === '..') {
    return { ok: false, reason: 'A file cannot be named . or ..' }
  }
  if (
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('\0')
  ) {
    return {
      ok: false,
      reason: 'Enter a single file name, not a path.',
    }
  }
  return { ok: true, path: parent === '' ? trimmed : `${parent}/${trimmed}` }
}
