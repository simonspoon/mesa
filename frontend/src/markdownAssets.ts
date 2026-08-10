/** Resolve the `src` of a markdown image to a repo-relative path the Files
 * content route can serve, or `null` when the caller must NOT render an `<img>`
 * at all.
 *
 * `fileDir` is the repo-relative directory of the markdown file holding the
 * link — `""` at the repo root. A `null` answer is a refusal, not an error:
 * remote and inline sources (`http:`, `data:`, protocol-relative `//host/…`)
 * are not ours to fetch, an anchor is not a file, and a `..` chain that walks
 * out of the repo is exactly the traversal `safe_path()` rejects server-side.
 * Refusing here keeps the browser from ever issuing the request.
 *
 * The answer is a real path, NOT a URL: percent-escapes in `src` are decoded
 * here, because the caller re-encodes the whole thing for the query string.
 * Leaving them would double-encode the common case — `![](my%20logo.png)` is
 * how markdown spells a file named `my logo.png`, and `%20` → `%2520` asks the
 * server for a file whose name literally contains `%20`. Decoding is done
 * per segment, AFTER the split on `/` and after `.`/`..` are resolved, so an
 * escaped separator or dot-segment can never appear from behind an escape: a
 * segment that decodes to one is refused outright rather than re-interpreted.
 * A malformed escape (`100%`) is a filename, not an error, and passes through
 * verbatim. Backslashes are ordinary characters, not separators — `/` is the
 * only separator on this path, on every platform. */
export function resolveMarkdownImageSrc(fileDir: string, src: string): string | null {
  const raw = src.trim()
  if (raw === '') return null
  // An anchor is a jump within the rendered document, not a file.
  if (raw.startsWith('#')) return null
  // Protocol-relative (`//cdn/x.png`) — a remote host, checked before the
  // repo-root-relative single `/`.
  if (raw.startsWith('//')) return null
  // Any absolute URL scheme: http, https, data, mailto, or one we've never
  // heard of. All remote or inline, none of them a file in this repo.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return null

  // `?query` / `#fragment` are cache-busters and anchors, never part of the
  // path on disk.
  const cut = raw.search(/[?#]/)
  const path = cut === -1 ? raw : raw.slice(0, cut)
  if (path === '') return null

  // A leading `/` means repo-root-relative, so it starts from an empty base
  // rather than from the markdown file's own directory.
  const rooted = path.startsWith('/')
  // `fileDir` is a real path handed over by the app, not a URL, so it is the
  // one part that is already decoded and must be left alone.
  const out: string[] = rooted
    ? []
    : fileDir.split('/').filter((segment) => segment !== '')
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      // Nothing left to pop means the link escapes the repo root.
      if (out.length === 0) return null
      out.pop()
      continue
    }
    const name = decodeSegment(segment)
    // `%2F`, `%2E%2E` and friends: a separator or a dot-segment arriving from
    // behind an escape is never a filename anyone meant to write, and honouring
    // it would let an escape re-enter the loop's own vocabulary.
    if (name === '.' || name === '..' || name.includes('/')) return null
    out.push(name)
  }
  if (out.length === 0) return null
  return out.join('/')
}

/** One path segment, percent-decoded. A malformed escape is not an error here:
 * `decodeURIComponent` throws on a lone `%`, but a file may well be called
 * `100%`, so the raw segment stands in. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}
