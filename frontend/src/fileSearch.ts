// Project-wide file search for the Files tab (mesa task 813, Cmd/Ctrl+Shift+F):
// the decisions the search panel makes, kept out of the component that paints
// it — the same rule `fileFind.ts` follows for the in-file bar beside it.
//
// The *matching* is not here. A project search runs server-side
// (`core::files::search_files`), because it is a filesystem walk and the
// browser has no tree to walk; what is left on this side is when a query is
// worth sending at all, how the result is summarised, and how a snippet's
// highlight is painted — and that last one delegates to `fileFind.ts` rather
// than re-implementing a scan, so the panel and the find bar can never
// disagree about what matches.

import { type FindOptions, type FindSegment, findMatches, findSegments } from './fileFind'
import type { ProjectFileSearch } from './types/ProjectFileSearch'

/** The longest query the panel will send — the mirror of
 * `core::files::MAX_SEARCH_QUERY`, used as the input's `maxLength` so an
 * over-long query is unreachable rather than a 422. The server stays
 * authoritative; this copy only saves the round trip, the same relationship
 * `newFile.ts` has to the create rules. */
export const MAX_SEARCH_QUERY = 200

/**
 * The query to search for, or `null` when there is nothing to ask.
 *
 * Empty is the only refusal, and it is not a trim: leading and trailing spaces
 * are searchable text in a code browser (` } else {`), so trimming would
 * silently search for something the user did not type. An all-whitespace query
 * is therefore a legitimate search — for whitespace.
 *
 * Over-long is clamped rather than refused, since the input's `maxLength`
 * already keeps typing inside the cap and a paste is the only way past it;
 * sending the first 200 characters beats a 422 the user cannot act on.
 */
export function searchRequestQuery(raw: string): string | null {
  if (raw === '') return null
  return raw.length > MAX_SEARCH_QUERY ? raw.slice(0, MAX_SEARCH_QUERY) : raw
}

/**
 * The line under the query box: what was found, in words.
 *
 * `null` is "no search has run yet" and says nothing at all — an empty panel
 * must not read as "no results" before a query has been sent.
 *
 * `truncated` is the server saying it stopped early (any of its four caps), so
 * the count is a floor rather than the total; `+` is how the label says so,
 * matching the in-file bar's own `2000+`. Never "0 of 0": a search that found
 * nothing says so in words.
 */
export function searchSummary(result: ProjectFileSearch | null): string {
  if (result === null) return ''
  if (result.total_matches === 0) return 'No results'
  const plus = result.truncated ? '+' : ''
  const results = `${result.total_matches}${plus} result${result.total_matches === 1 ? '' : 's'}`
  const files = `${result.files.length}${plus} file${result.files.length === 1 ? '' : 's'}`
  return `${results} in ${files}`
}

/**
 * One result row's snippet, cut into plain and matched runs for painting.
 *
 * The server sends the snippet and *not* the match's offsets inside it
 * (`FileSearchMatch`): a char offset computed in Rust is not a UTF-16 offset in
 * JS, and this side already owns the identical literal scan. Re-running it here
 * is therefore the same answer arrived at without a coordinate conversion — and
 * when the two do disagree (a snippet windowed through the middle of a match,
 * a case-folding difference at the edges), the cost is a row painted without a
 * highlight rather than a row pointing at the wrong place.
 */
export function snippetSegments(
  text: string,
  query: string,
  options: FindOptions,
): FindSegment[] {
  return findSegments(text, findMatches(text, query, options).matches)
}
