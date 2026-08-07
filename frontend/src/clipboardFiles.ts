/**
 * Turning a clipboard paste into staged attachment files (mesa task 775).
 *
 * A pure module rather than an `onPaste` body inside `CreateTaskPanel.tsx`, for
 * the reason CLAUDE.md gives: this is a predicate ("is this paste an image, and
 * what should the file be called?") and a component is not where it can be
 * tested. The panel keeps only the wiring — call this, and if it returns
 * anything, `preventDefault()` and stage it.
 *
 * The load-bearing part is the FILENAME. Clipboard images arrive with an empty
 * or generic name, and `guess_content_type` in `src/core/attachments.rs` is
 * extension-only (no magic-byte sniffing, deliberately — no new dependency). A
 * name with no recognised extension is stored with `content_type: null`, which
 * kills the `<img className="attachment-preview">` render on the task panel. So
 * a pasted image is renamed to `pasted-<now>.<ext>` with an extension derived
 * from the MIME type the clipboard *does* supply.
 */

/** The subset of `DataTransferItem` this module reads. */
export type ClipboardEntry = {
  kind?: string
  type?: string
  getAsFile?: () => File | null
}

/** The subset of `DataTransfer` this module reads. */
export type ClipboardLike = {
  items?: ArrayLike<ClipboardEntry> | null
  files?: ArrayLike<File> | null
} | null

/**
 * MIME type -> extension, for exactly the image types the Rust guesser knows.
 * Anything else falls back to the subtype text (see `extensionFor`) and lands
 * as `content_type: null` server-side — acceptable, and already what an unknown
 * upload does.
 */
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

/**
 * Extensions that already produce an `image/*` content type on the server, so a
 * clipboard entry arriving with such a name is left alone. `jpeg` is here as
 * well as `jpg` because the Rust guesser maps both.
 */
const KEEPABLE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']

function extensionFor(type: string): string {
  const mime = type.toLowerCase()
  const known = IMAGE_EXTENSIONS[mime]
  if (known) return known
  // `image/heic` -> `heic`; `image/vnd.foo+xml` -> `vnd.foo`.
  return mime.slice('image/'.length).split('+')[0]
}

function hasKeepableExtension(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return false
  return KEEPABLE_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase())
}

/**
 * Every `image/*` file on `data`, renamed so the server can type it.
 *
 * Returns `[]` for a paste carrying no image — a plain-text paste, the usual
 * case, must fall through to the focused input untouched, so the caller keys
 * its `preventDefault()` off a non-empty result.
 *
 * A macOS screenshot paste carries both an image and text; only the image is
 * taken. `now` is a parameter, not `Date.now()` in here, so the synthesised
 * names are deterministic under test; the caller passes `Date.now()`.
 */
export function imageFilesFromClipboard(
  data: ClipboardLike,
  now: number,
): File[] {
  if (!data) return []
  const entries = data.items ? Array.from(data.items) : []
  const raw: File[] = entries.length
    ? entries
        .map((entry) => (entry.getAsFile ? entry.getAsFile() : null))
        .filter((file): file is File => file !== null)
    : Array.from(data.files ?? [])

  const images = raw.filter((file) => (file.type ?? '').startsWith('image/'))
  return images.map((file, i) => {
    if (file.name && hasKeepableExtension(file.name)) return file
    const suffix = i === 0 ? '' : `-${i}`
    const name = `pasted-${now}${suffix}.${extensionFor(file.type)}`
    return new File([file], name, { type: file.type })
  })
}
