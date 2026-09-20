// Where a CC session drill-down was reached from (mesa task 1234).
//
// `#/cc/sessions/<id>` is linked from two Sessions tables: the global CC
// Dashboard's, and the project-scoped copy on `#/projects/<id>/dashboard`.
// The back link has to return to whichever one it came from, so the origin
// rides **in the route** as a `?project=<id>` suffix rather than in component
// state or a history/referrer guess — which is what makes it survive a reload
// and a copied URL.
//
// An absent, empty or malformed `?project=` is simply no origin: every page
// then behaves exactly as it did before, never an error.

/** The project whose dashboard linked to a CC session page, or null for the
 *  global CC Dashboard. */
export type CcOrigin = number | null

/** Split a hash path into its path and its query string.
 *
 *  `App`'s route patterns match path segments with `[^/]+`, which would
 *  swallow a `?project=3` suffix whole, so this runs **once, before** any of
 *  them. The query is returned without its `?`; a path with none gives `''`. */
export function splitHashQuery(hash: string): { path: string; query: string } {
  const i = hash.indexOf('?')
  return i === -1
    ? { path: hash, query: '' }
    : { path: hash.slice(0, i), query: hash.slice(i + 1) }
}

/** The origin carried by a hash path, or null if it carries none.
 *
 *  Only a positive integer counts: a missing, empty, non-numeric or negative
 *  value degrades to the global behaviour. */
export function ccOriginFromHash(hash: string): CcOrigin {
  const raw = new URLSearchParams(splitHashQuery(hash).query).get('project')
  return raw !== null && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : null
}

function suffix(origin: CcOrigin): string {
  return origin === null ? '' : `?project=${origin}`
}

/** The Sessions table's row link — the session detail page, carrying the
 *  origin the table itself was rendered for. */
export function ccSessionHref(sessionId: string, origin: CcOrigin): string {
  return `#/cc/sessions/${encodeURIComponent(sessionId)}${suffix(origin)}`
}

/** The detail page's link one drill-down further in, forwarding the origin so
 *  the whole chain back out stays intact. */
export function ccTimelineHref(sessionId: string, origin: CcOrigin): string {
  return `#/cc/sessions/${encodeURIComponent(sessionId)}/timeline${suffix(origin)}`
}

/** The detail page's back link: out to the project dashboard it was reached
 *  from, else out to the global Sessions table.
 *
 *  `projectName` is the detail payload's own `project` — transcript text, so
 *  it is rendered as a text child and may not have landed yet, which is what
 *  the nameless label covers. */
export function ccBackLink(
  origin: CcOrigin,
  projectName: string | null,
): { href: string; label: string } {
  if (origin === null) return { href: '#/cc/sessions', label: '← Sessions' }
  return {
    href: `#/projects/${origin}/dashboard`,
    label: projectName ? `← ${projectName} dashboard` : '← Dashboard',
  }
}
