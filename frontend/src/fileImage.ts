/** The image allowlist, keyed off a path's lowercased final extension.
 *
 * This table is a MIRROR of `core::files::image_mime` in the Rust crate (the
 * same relationship `syntaxHighlighter.ts`'s `PRISM_GRAMMAR` has to
 * `language_of`): the server decides what it will serve as an image, and the
 * client decides what it will render as one. A change to either side is a
 * change to both — a client-only addition renders a broken `<img>`, a
 * server-only one is never asked for.
 *
 * Extension-keyed, deliberately: `foo.png.html` is an HTML file. Anything
 * without a final extension — no dot at all, or a leading-dot name like
 * `.gitignore` — is not an image. */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
}

/** The MIME type this path would be served as, or `null` when it is not one of
 * the allowlisted image types. */
export function imageMimeForPath(path: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  // `dot <= 0` covers both "no extension" and a dotfile whose only dot leads
  // the name (`.gitignore` is a file called gitignore, not a `gitignore` type).
  if (dot <= 0) return null
  return IMAGE_MIME[base.slice(dot + 1).toLowerCase()] ?? null
}

/** Whether this path should be rendered as an image rather than as text. */
export function isImagePath(path: string): boolean {
  return imageMimeForPath(path) !== null
}
