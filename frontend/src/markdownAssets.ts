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
 * Percent-escapes are left EXACTLY as written: the caller re-encodes this path
 * for the content query string, so decoding here would double-decode a literal
 * `%20` in a filename. Backslashes are ordinary characters, not separators —
 * `/` is the only separator on this path, on every platform. */
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
  const base = rooted ? [] : fileDir.split('/')
  const out: string[] = []
  for (const segment of [...base, ...path.split('/')]) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      // Nothing left to pop means the link escapes the repo root.
      if (out.length === 0) return null
      out.pop()
      continue
    }
    out.push(segment)
  }
  if (out.length === 0) return null
  return out.join('/')
}
