// The arithmetic behind the Files tab's line-number gutter and status bar
// (mesa task 809). It lives here rather than inline in `FilesView` /
// `CodeEditor` for the reason the other pure modules do: a gutter that is one
// line out, or a caret that reports the wrong column at a CRLF boundary, is
// invisible in a screenshot and obvious in a unit test — and these are exactly
// the predicates that historically shipped wrong.
//
// Two line counts, deliberately not one. A `<textarea>` shows a trailing
// newline as a real, empty last line the caret can sit on; a `<pre>` swallows
// exactly one (the same asymmetry `highlightOverlaySource` pads around). So
// `lineCount` answers for the editor and `viewerLineCount` for the read-only
// pane, and each gutter is built from the count of the thing it sits beside.

/** A caret's 1-based position, the way every editor's status bar states it. */
export interface CaretPosition {
  line: number
  col: number
}

/** True at `i` if the character there ends a line — a lone `\n`, or a lone
 * `\r` (old-Mac endings). The `\n` of a `\r\n` pair is the one that counts, so
 * a CRLF file is not double-counted; a `\r` is only a break when nothing
 * follows it. A textarea's `value` is always LF-normalised by the platform, but
 * file content read off disk is not, and the same functions serve both. */
function endsLine(value: string, i: number): boolean {
  if (value[i] === '\n') return true
  return value[i] === '\r' && value[i + 1] !== '\n'
}

/** Where the caret is, given the textarea's `value` and its `selectionStart`.
 *
 * A scan rather than a `split`: the offset is what the browser hands us, and
 * splitting to find the line it falls in allocates the whole file per
 * keystroke. An out-of-range or non-integer offset (a stale value read after
 * the text shrank) clamps into the string instead of reporting a negative
 * column. */
export function caretPosition(value: string, selectionStart: number): CaretPosition {
  const offset = Number.isFinite(selectionStart)
    ? Math.min(Math.max(Math.trunc(selectionStart), 0), value.length)
    : 0
  let line = 1
  let lineStart = 0
  for (let i = 0; i < offset; i++) {
    if (endsLine(value, i)) {
      line++
      lineStart = i + 1
    }
  }
  return { line, col: offset - lineStart + 1 }
}

/** Lines as the *editor* counts them: one more than the number of line breaks,
 * so `"a\n"` is two lines — the empty second one is where the caret lands after
 * pressing Enter at the end, and a gutter that omitted it would be short a row
 * for the file most source files are (every one ending in a newline). */
export function lineCount(value: string): number {
  let lines = 1
  for (let i = 0; i < value.length; i++) {
    if (endsLine(value, i)) lines++
  }
  return lines
}

/** Lines as the read-only `<pre>` *paints* them: `lineCount` minus the trailing
 * empty line, because a `<pre>` swallows one trailing newline. Counting logical
 * lines here would put an unnumbered blank row's number at the bottom of the
 * gutter and read as an off-by-one against the code beside it. */
export function viewerLineCount(value: string): number {
  const lines = lineCount(value)
  return lines > 1 && endsLine(value, value.length - 1) ? lines - 1 : lines
}

/**
 * File content as the editor deals with it: LF only.
 *
 * A `<textarea>`'s `value` is spec-defined to hand back every CR/CRLF as a
 * single LF, so a draft seeded straight from the bytes on disk is not
 * offset-for-offset the string the DOM will report — a CRLF file's find
 * offsets, and the reveal built from them, land one character early per line
 * ahead of the match, until the first keystroke replaces the draft with the
 * browser's own normalised copy. Normalising once, where the draft is seeded,
 * is what makes that mismatch impossible rather than merely rare, and it makes
 * the dirty comparison honest as well: the baseline and the draft are then the
 * same dialect. (The trade is that saving a CRLF file writes LF — which is
 * already what happens the moment the user types a character, so this makes the
 * behaviour consistent rather than introducing it.)
 */
export function normalizeNewlines(content: string): string {
  return content.replace(/\r\n?/g, '\n')
}

/** The offset a 1-based line starts at — the anchor a search "from what I am
 * looking at" needs, where the caret cannot supply one because the pane is
 * read-only. Clamped past the end of the file rather than answering -1: the
 * anchor is a starting point for `matchIndexFrom`, which wraps. */
export function offsetForLine(value: string, line: number): number {
  const target = Number.isFinite(line) ? Math.max(Math.trunc(line), 1) : 1
  if (target === 1) return 0
  let at = 1
  for (let i = 0; i < value.length; i++) {
    if (!endsLine(value, i)) continue
    at++
    if (at === target) return i + 1
  }
  return value.length
}

/** The 1-based line at the top of a viewport, given how many pixels of the text
 * have scrolled above it and how tall one line is.
 *
 * Only meaningful with soft wrap off, for the same reason the gutter is: a
 * wrapped logical line is several visual rows and this would count them as
 * several lines. A missing or nonsensical measurement (an unmounted node reads
 * as `NaN`) answers line 1, which is where a search with no anchor starts
 * anyway. */
export function lineAtScroll(hiddenHeight: number, lineHeight: number): number {
  if (!Number.isFinite(hiddenHeight) || !Number.isFinite(lineHeight)) return 1
  if (lineHeight <= 0 || hiddenHeight <= 0) return 1
  return Math.floor(hiddenHeight / lineHeight) + 1
}

/** The gutter's whole text, as one newline-joined string.
 *
 * One string in one `<pre>` rather than an element per line: per-element
 * margins, borders or a stray line-height are precisely how a gutter shears off
 * the code, and a single text node in a `pre` box has none of that to get
 * wrong — its rows are laid out by the same line-breaking pass as the code's.
 * No trailing newline, so the `<pre>`'s own swallowing never applies. */
export function gutterText(lines: number): string {
  const total = Number.isFinite(lines) ? Math.max(Math.trunc(lines), 1) : 1
  const out: string[] = []
  for (let n = 1; n <= total; n++) out.push(String(n))
  return out.join('\n')
}

/** The narrowest column, in characters, that fits every number `gutterText`
 * will put in it.
 *
 * The editor's gutter is absolutely positioned, so unlike the read-only pane's
 * it cannot size itself to its content — its width and the padding that pushes
 * the code clear of it are two separate declarations, and a fixed value for
 * both is what clipped a six-digit number on its LEFT (`131072` painting as
 * `31072`, a plausible wrong number rather than a visibly truncated one) on any
 * file long enough to need one. `FILE_CONTENT_CAP` is 256 KiB, which is well
 * over a hundred thousand lines of a log or a generated fixture, so six digits
 * is a real file and not a hypothetical.
 *
 * Floored at 2 so a short file doesn't get a razor-thin rail, and defensive
 * about its input the same way `gutterText` is — the two are always called with
 * the same count and must never disagree about it. */
export function gutterDigits(lines: number): number {
  const total = Number.isFinite(lines) ? Math.max(Math.trunc(lines), 1) : 1
  return Math.max(String(total).length, 2)
}
