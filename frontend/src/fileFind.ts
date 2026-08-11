// Find-in-file for the Files tab (mesa task 809): every decision the find bar
// makes about *where* the matches are, kept out of the components that paint
// them. It lives here for the reason the other pure modules do — an off-by-one
// in "3 of 7", a whole-word rule that eats `don` out of `don't`, or a wrap-
// around that skips the first match are all invisible in a screenshot and
// obvious in a unit test.
//
// Two callers, one enumeration: the read-only pane paints every match as a
// highlight layer over the code, and the editor selects one match at a time in
// its textarea. Both work in **offsets into the same string**, which is why
// nothing here knows about lines, DOM nodes or Prism markup.
//
// The search is a literal substring scan, never a regular expression. A query
// is a user's typing, not a pattern language: `RegExp` would turn `(` into a
// syntax error and `.*` into a surprise, and building one from arbitrary text
// is the same class of mistake as splicing a value into a shell string.

/** One hit, as a half-open offset range into the searched text. */
export interface FindMatch {
  start: number
  end: number
}

/** The two toggles the bar offers. Both off is the plain case. */
export interface FindOptions {
  caseSensitive: boolean
  wholeWord: boolean
}

/** What `findMatches` answers: the hits, and whether it stopped early. */
export interface FindResult {
  matches: FindMatch[]
  /** True when the file holds more matches than were returned. */
  capped: boolean
}

/** The most matches one search reports.
 *
 * Not a performance guess: the read-only pane renders one element per match,
 * and a single-letter query against a 256 KiB file (the content route's own
 * ceiling) is tens of thousands of them — enough DOM to lock the tab up for
 * seconds on a keystroke that was probably a typo on the way to a longer word.
 * Stopping is the honest answer, and `capped` is how the label says so ("1 of
 * 2000+") rather than quietly claiming the file has exactly this many. */
export const MAX_FIND_MATCHES = 2000

/** The word characters a whole-word boundary is drawn against — ASCII letters,
 * digits and `_`, the same set every editor's "Whole Word" toggle uses. Not
 * `\w` on a unicode-aware class: widening it would change which matches a
 * stored preference finds, and this is a code browser. */
function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch)
}

/** True when `a` and `b` are the same character under the chosen case rule.
 *
 * Folded per character rather than by lowercasing the whole file, and that is
 * load-bearing: `'İ'.toLowerCase()` is *two* code units, so a lowercased copy
 * of the text is not offset-for-offset the original, and every match found in
 * it would point at the wrong place in the string the caller is about to
 * highlight. Folding one character at a time can only ever answer "these two
 * are the same or they are not", so the offsets stay exact. (The cost is that
 * a case-expanding character never matches its lowercase form — a fair trade
 * against silently misplaced highlights.) */
function sameChar(a: string, b: string, caseSensitive: boolean): boolean {
  if (a === b) return true
  if (caseSensitive) return false
  return a.toLowerCase() === b.toLowerCase()
}

function matchesAt(
  text: string,
  query: string,
  at: number,
  caseSensitive: boolean,
): boolean {
  for (let i = 0; i < query.length; i++) {
    if (!sameChar(text[at + i], query[i], caseSensitive)) return false
  }
  return true
}

/**
 * Every match of `query` in `text`, in order, never overlapping.
 *
 * An empty query is "no matches", not "every position": the bar is live as the
 * user types, and the moment before the first character is the moment the whole
 * file would otherwise light up.
 *
 * Whole-word asks for a boundary only on the sides where the *query itself*
 * ends in a word character — searching `(x` with the toggle on still finds
 * `f(x)`, because a `(` has no word boundary to demand. That is what VS Code
 * does, and the alternative (always demanding one) makes the toggle silently
 * useless for anything but bare identifiers.
 *
 * Termination is structural: the scan index only ever moves forward, by one
 * position on a miss and by the whole (non-empty) query on a hit, so no input
 * can loop.
 */
export function findMatches(
  text: string,
  query: string,
  options: FindOptions,
): FindResult {
  if (query === '') return { matches: [], capped: false }
  const matches: FindMatch[] = []
  const headIsWord = isWordChar(query[0])
  const tailIsWord = isWordChar(query[query.length - 1])
  for (let i = 0; i + query.length <= text.length; i++) {
    if (!matchesAt(text, query, i, options.caseSensitive)) continue
    const end = i + query.length
    if (options.wholeWord) {
      if (headIsWord && isWordChar(text[i - 1])) continue
      if (tailIsWord && isWordChar(text[end])) continue
    }
    matches.push({ start: i, end })
    // One past the cap is what proves there *are* more — reporting `capped`
    // off a full array alone would flag a file holding exactly the cap.
    if (matches.length > MAX_FIND_MATCHES) {
      matches.pop()
      return { matches, capped: true }
    }
    i = end - 1
  }
  return { matches, capped: false }
}

/**
 * The match a fresh search should land on, given where the caret is: the first
 * one at or after `offset` going forward, the last one before it going back —
 * and, with none in that direction, the one at the far end, because a find bar
 * that reported "no results" for a file full of matches merely because the
 * caret sat past the last one would be lying.
 *
 * `-1` when there is nothing to land on. That is the only case: the wrap makes
 * every other input answer with a real index.
 */
export function matchIndexFrom(
  matches: FindMatch[],
  offset: number,
  forward: boolean,
): number {
  if (matches.length === 0) return -1
  if (forward) {
    const i = matches.findIndex((m) => m.start >= offset)
    return i === -1 ? 0 : i
  }
  for (let i = matches.length - 1; i >= 0; i--) {
    if (matches[i].start < offset) return i
  }
  return matches.length - 1
}

/**
 * Next/previous from the match currently shown, wrapping at both ends — Enter
 * on the last match goes back to the first, which is what every editor does and
 * what makes Enter-Enter-Enter a way to walk a file rather than a way to get
 * stuck at the bottom of it.
 *
 * An index that is not a real match (nothing selected yet, or a list that
 * shrank under it as the query grew) enters at the near end for the direction
 * asked, rather than being treated as position zero.
 */
export function stepMatch(
  matches: FindMatch[],
  index: number,
  forward: boolean,
): number {
  const total = matches.length
  if (total === 0) return -1
  if (!Number.isInteger(index) || index < 0 || index >= total) {
    return forward ? 0 : total - 1
  }
  return forward ? (index + 1) % total : (index - 1 + total) % total
}

/**
 * Where the *next* search should start from, once the user has stepped onto a
 * match: that match's own start, or the anchor they had if there is no match to
 * take one from.
 *
 * The anchor a search runs from is captured when the bar opens, so that growing
 * a query walks forward from what the user was looking at rather than jumping
 * about as the caret follows each selection. That is right for the first few
 * characters and wrong the moment a step has happened: search `foo`, press
 * Enter four times to reach a match 800 lines down, then type one more
 * character to narrow it to `foobar`, and a fixed anchor teleports you back to
 * the first `foobar` at or after where you *started*. Every editor re-anchors
 * on the current match so that refining a query narrows in place, and this is
 * that rule — it moves only on a step, so a freshly opened bar still anchors
 * where it always did.
 */
export function anchorAfterStep(
  matches: FindMatch[],
  index: number,
  fallback: number,
): number {
  if (!Number.isInteger(index) || index < 0 || index >= matches.length) {
    return fallback
  }
  return matches[index].start
}

/**
 * The counter beside the query box.
 *
 * "No results" rather than "0 of 0" for the empty case: zero of zero reads as a
 * broken counter, and this is the one state the user needs to recognise at a
 * glance. An index outside the list is clamped rather than shown as `0 of N` —
 * with matches on screen there is always one of them current.
 */
export function matchLabel(
  index: number,
  total: number,
  capped: boolean,
): string {
  if (total <= 0) return 'No results'
  const shown = Math.min(Math.max(Math.trunc(index), 0), total - 1)
  return `${shown + 1} of ${total}${capped ? '+' : ''}`
}

/** A run of the searched text: plain when `match` is `-1`, otherwise the index
 * of the match it is. */
export interface FindSegment {
  text: string
  match: number
}

/**
 * `text` cut into alternating plain and matched runs, ready to be painted as
 * one element per run.
 *
 * This exists so the highlight layer is built from the *same string* the search
 * ran over and never from the syntax-highlighted markup beside it: Prism's
 * output is a tree of nested spans whose text nodes cut across match
 * boundaries, and splicing highlights into it would mean rewriting somebody
 * else's DOM by offset — one bad boundary and the colouring is corrupt. A flat
 * list of runs, rendered as its own inert layer over an untouched Prism tree,
 * cannot corrupt anything: the worst a bug here can do is misplace a
 * background.
 *
 * Defensive about its input (out-of-range, empty or out-of-order ranges are
 * skipped) because a match list and the text it came from can disagree for one
 * render while a draft is being typed.
 */
export function findSegments(text: string, matches: FindMatch[]): FindSegment[] {
  const out: FindSegment[] = []
  let at = 0
  matches.forEach((m, i) => {
    const start = Math.max(m.start, at)
    const end = Math.min(m.end, text.length)
    if (end <= start) return
    if (start > at) out.push({ text: text.slice(at, start), match: -1 })
    out.push({ text: text.slice(start, end), match: i })
    at = end
  })
  if (at < text.length) out.push({ text: text.slice(at), match: -1 })
  return out
}

/**
 * The `scrollTop` that brings a 1-based line into a textarea's viewport, moving
 * as little as possible — the "reveal" every editor does when a search lands
 * off screen, and nothing when the line is already visible (stepping between
 * two matches on screen must not jump the view).
 *
 * Arithmetic rather than `scrollIntoView` because the thing to reveal is an
 * offset inside a `<textarea>`, which has no element to scroll to. It holds
 * only while every line is one row tall, which is why the caller applies it
 * only with soft wrap off; wrapped, a logical line and a visual row are not the
 * same thing and this would undershoot. A missing or nonsensical line height
 * (an unmounted node measures as `NaN`) leaves the scroll alone rather than
 * jumping to the top.
 */
export function scrollTopForLine(
  line: number,
  lineHeight: number,
  viewportHeight: number,
  scrollTop: number,
): number {
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) return scrollTop
  const top = (Math.max(Math.trunc(line), 1) - 1) * lineHeight
  return scrollTopForBox(top, lineHeight, viewportHeight, scrollTop)
}

/**
 * The same reveal, for a box whose position was **measured** rather than
 * calculated — `offsetTop`/`offsetHeight` of the current `<mark>` in the find
 * layer.
 *
 * This is what makes find work in the editor with soft wrap **on**. Wrapped, a
 * logical line is several visual rows, so `scrollTopForLine`'s line×height
 * undershoots and the caller used to skip the scroll altogether: the counter
 * stepped, the current-match class moved, and the view sat still with the match
 * off screen — worse than no find at all, and silently, for the rest of a
 * session in which the user turned wrap on. The layer that paints the
 * highlights is aligned to the text in *both* wrap modes by construction, so
 * the mark's own offset is the one number the arithmetic cannot produce and the
 * DOM already has. (The viewer does the *vertical* equivalent with
 * `scrollIntoView`; a textarea has no element inside it to scroll to, which is
 * why this is a number and not a call. Its sideways half is the function
 * below — `scrollIntoView` has no notion of an overlay, so the gutter would
 * swallow the match there exactly as it would here.)
 */
export function scrollTopForBox(
  top: number,
  height: number,
  viewportHeight: number,
  scrollTop: number,
): number {
  if (!Number.isFinite(top) || !Number.isFinite(height)) return scrollTop
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return scrollTop
  const bottom = top + Math.max(height, 0)
  if (top < scrollTop) return Math.max(top, 0)
  if (bottom > scrollTop + viewportHeight) {
    return Math.max(bottom - viewportHeight, 0)
  }
  return scrollTop
}

/**
 * Whether a measured box has to be scrolled to at all: true when it falls
 * outside the *readable* band of a viewport, false when it is already inside
 * it.
 *
 * The viewer reveals a match by handing the mark to `scrollIntoView({block:
 * 'center'})`, which has no "already visible" case — it re-centres
 * unconditionally, so stepping between two matches a few lines apart threw the
 * file up or down by half a pane on every Enter, while the editor beside it (via
 * `scrollTopForBox`, which returns the current scroll for a box already in view)
 * did not move at all. Two panes, one keystroke, two behaviours, and the rule
 * this module already states — "nothing when the line is already visible" — was
 * implemented on only one of them. This is that test, for the caller that cannot
 * express it as a scroll offset.
 *
 * The band is not the scrollport: `.files-content-top` (header + find bar) is
 * pinned over its top and the status bar over its bottom, so a match under
 * either is *painted* and not *readable*, and reporting it as visible is the
 * same class of mistake `scrollLeftForBox`'s lead-in exists for on the other
 * axis. Callers pass the band, in the same coordinate space as the box, rather
 * than the function knowing about any of those elements.
 *
 * A measurement it cannot use — a non-finite number, or a band with no height
 * because the pane is not laid out yet — answers "reveal it": scrolling to a
 * match that was already on screen is a jump, but skipping one that was not is
 * the silent "the counter stepped and the view sat still" failure.
 */
export function boxNeedsReveal(
  top: number,
  height: number,
  bandTop: number,
  bandBottom: number,
): boolean {
  if (!Number.isFinite(top) || !Number.isFinite(height)) return true
  if (!Number.isFinite(bandTop) || !Number.isFinite(bandBottom)) return true
  if (bandBottom <= bandTop) return true
  return top < bandTop || top + Math.max(height, 0) > bandBottom
}

/**
 * The same reveal sideways: the `scrollLeft` that brings a measured box into a
 * horizontal scrollport whose leftmost `obscuredLeft` pixels are painted over.
 *
 * A separate function rather than a second call to `scrollTopForBox` because
 * the horizontal viewport is not the whole box. A line-number gutter is an
 * opaque layer over the left edge of the same scrollport — absolutely
 * positioned in the editor's stack, `position: sticky` in the viewer's row —
 * so a reveal that merely brought a match to `scrollLeft` would put it exactly
 * *under* the numbers and report success. Nothing vertical has an equivalent —
 * the header, the find bar and the status bar are outside both boxes — which is
 * why the lead-in lives here and not in the function above.
 *
 * **Both panes need it**, which is why the lead-in is a parameter rather than
 * the editor's own constant. In the editor sideways matters at all only because
 * the reveal deliberately leaves the textarea unfocused while the find bar steps
 * (`CodeEditor.reveal`), so the browser never scrolls the selection into view by
 * itself. The viewer *has* an element to scroll to and uses `scrollIntoView` for
 * the vertical half — but `inline: 'nearest'` aligns a match lying left of the
 * view flush to the scrollport's left edge, i.e. behind the sticky gutter, since
 * nothing tells the browser that band is covered. One pane arrives here from
 * arithmetic it cannot do and the other from a call that does not know about
 * overlays; the answer is the same either way.
 *
 * *Measured* from the find layer's mark rather than calculated from a column,
 * because a column offset is not a pixel offset once a tab or a wide glyph is in
 * the line.
 */
export function scrollLeftForBox(
  left: number,
  width: number,
  viewportWidth: number,
  scrollLeft: number,
  obscuredLeft: number,
): number {
  const lead =
    Number.isFinite(obscuredLeft) && obscuredLeft > 0 ? obscuredLeft : 0
  // Shifting the box left by the lead-in and growing it by the same amount is
  // exactly "keep it inside the *unobscured* band": the left test then fires
  // while the box is still under the gutter, and the right edge is unchanged.
  return scrollTopForBox(left - lead, width + lead, viewportWidth, scrollLeft)
}
