/** Whether this path is an HTML *document* — the read view renders it as the
 * page it is, rather than as its source (mesa task 1249).
 *
 * Keyed on the path's final extension, deliberately NOT on the server's
 * `language` tag: `core::files::language_of` sends `.vue`, `.svelte` and
 * `.astro` to `"html"` as well, and those are component sources whose read
 * view is highlighted code. `.htm` is here even though the server has no
 * language for it at all, because the question this answers is "is this a web
 * page", not "which grammar colours it".
 *
 * Extension-keyed the same way `fileImage.ts` is, and for the same reasons:
 * `index.html.txt` is a text file, and a leading-dot name like `.html` is a
 * file called html rather than a document. */
export function isHtmlDocumentPath(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  // `dot <= 0` covers both "no extension" and a dotfile whose only dot leads
  // the name (the rule `imageMimeForPath` states).
  if (dot <= 0) return false
  const ext = base.slice(dot + 1).toLowerCase()
  return ext === 'html' || ext === 'htm'
}
