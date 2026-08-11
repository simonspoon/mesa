// What a keystroke *means* in the Files tab's code editor (mesa task 809) —
// the indent, auto-indent, auto-close and type-over behaviours that separate a
// code editor from a `<textarea>`. It is a pure module for the reason
// `navOrder.ts`, `fileTabs.ts` and `newFile.ts` are: the part that ships wrong
// is what a key *resolves to* (which lines a Shift+Tab touches, where the caret
// lands after a brace expansion), and that is reachable by vitest, whereas
// nothing about it is visible in a screenshot. `CodeEditor.tsx` therefore holds
// no rules at all — it reads the textarea, asks this module, and applies the
// answer.
//
// Every function is total and side-effect-free: it takes the text and the
// selection, and answers either the whole new state or `null` meaning "this is
// not ours — let the browser do what it always did". `null` is not a failure
// mode, it is the default: a plain Enter on an unindented line, an ordinary
// character, Backspace anywhere but between a pair. Leaving those to the
// browser is what keeps native undo, IME composition and spellcheck intact for
// the overwhelming majority of keystrokes.
//
// A `<textarea>`'s `value` is normalised to LF by the platform whatever the
// file on disk contains, so this module deals in `\n` only — unlike
// `editorStatus.ts`, which also measures content read straight off disk and has
// to count a lone `\r`.

/** The document and selection a keystroke resolves to, in the same shape the
 * textarea itself exposes. */
export interface EditResult {
  value: string
  selectionStart: number
  selectionEnd: number
}

/** Two spaces — the fallback unit, used for a file that has no indentation to
 * learn from (a new file, a flat config). One unit, not a tab-stop calculation:
 * a tab stop only differs from a fixed unit when the caret sits
 * mid-indentation, which is the case nobody types into. */
export const INDENT_UNIT = '  '

/** How many lines of a file are worth reading to decide how it is indented.
 * A whole 256 KiB file per keystroke would be a scan nobody asked for, and a
 * file whose first two hundred lines say nothing about its indentation is not
 * going to be settled by its last two hundred either. */
const DETECT_LINES = 200

/**
 * The indent unit *this file* is written with — one tab, or the run of spaces
 * its own lines are indented in multiples of.
 *
 * This exists because the editor browses arbitrary repos, not this one: mesa's
 * own `src/*.rs` is four spaces and `scripts/*.sh` is tabs, and a hardcoded two
 * spaces means Tab inserts the wrong width in both. Worse than wrong is
 * *mixed*: `autoIndent` carries the line's existing whitespace (tab-agnostic,
 * correct) and then appends one unit after `{`, so a fixed two spaces turns a
 * tab-indented block into tabs-then-spaces — mixed indentation written back to
 * disk by a tool the user opened to change one line.
 *
 * The rule is the cheap version of what every editor does: tally the leading
 * whitespace of the first `DETECT_LINES` indented lines, and answer whichever
 * width occurred most often, ties going to the narrower (a 2-space file has
 * plenty of 4-column continuation lines; a 4-space file has almost no 2s). A
 * tab anywhere in the leading whitespace is a vote for tabs, and tabs win
 * outright when they outnumber every single space width — a file cannot be
 * indented with both, and a stray aligned comment must not turn a tab file into
 * a space file.
 *
 * A heuristic, deliberately: it decides what a *new* indent looks like and
 * never rewrites indentation that is already there, so the worst a wrong answer
 * does is insert a two-space indent in a four-space file — which is what
 * shipped before this function existed.
 */
export function detectIndentUnit(value: string): string {
  const widths = new Map<number, number>()
  let tabs = 0
  let seen = 0
  let at = 0
  while (at <= value.length && seen < DETECT_LINES) {
    const brk = value.indexOf('\n', at)
    const line = value.slice(at, brk === -1 ? value.length : brk)
    at = (brk === -1 ? value.length : brk) + 1
    const indent = line.match(/^[ \t]+/)?.[0]
    // A line with no indentation says nothing, and a blank line's whitespace is
    // trailing whitespace rather than an indent.
    if (indent === undefined || indent.length === line.length) {
      if (brk === -1) break
      continue
    }
    seen++
    if (indent.includes('\t')) tabs++
    else widths.set(indent.length, (widths.get(indent.length) ?? 0) + 1)
    if (brk === -1) break
  }
  let best = 0
  let bestVotes = 0
  for (const [width, votes] of widths) {
    if (votes > bestVotes || (votes === bestVotes && width < best)) {
      best = width
      bestVotes = votes
    }
  }
  if (tabs > bestVotes) return '\t'
  if (best === 0) return INDENT_UNIT
  // Eight is where an indent stops being an indent and starts being alignment;
  // anything wider is far more likely to be a continuation line than a unit.
  return ' '.repeat(Math.min(best, 8))
}

const OPEN_PAIRS: Record<string, string> = { '{': '}', '[': ']', '(': ')' }
const CLOSE_PAIRS: Record<string, string> = { '}': '{', ']': '[', ')': '(' }
const QUOTES = new Set(["'", '"', '`'])

/** What may follow the caret and still get an auto-closed pair. Closing before
 * a word character is the one case that is nearly always wrong — typing `(` in
 * front of an existing identifier means wrapping it, not orphaning a `)` in the
 * middle of it — so the rule is an allowlist of "nothing meaningful follows":
 * end of file, whitespace, or a closer/separator. */
const CLOSE_BEFORE = /^[\s)\]}>,;:.]$/

/** A character that makes a quote part of a word rather than a delimiter — the
 * apostrophe in `don't`, which must not become `don''t`. */
const WORD = /[\w$]/

/** The offset the line containing `offset` starts at. */
function lineStartAt(value: string, offset: number): number {
  return value.lastIndexOf('\n', offset - 1) + 1
}

/** The whole-line span a selection touches, plus whether it crosses a line
 * boundary — the distinction Tab turns on.
 *
 * `multiline` asks whether the selected *text* holds a newline, not whether the
 * trimmed block spans two lines, because those differ exactly where it matters:
 * a selection ending at the next line's first column reads as one line's worth
 * of block indent, and replacing it with two spaces (Tab's single-line
 * behaviour) would splice two lines together.
 *
 * That trailing line is then excluded from the block itself: dragging down
 * through three lines to land on the fourth's start is a three-line selection
 * everywhere else, and indenting a fourth line nobody highlighted is the kind
 * of surprise that costs a whole undo. */
function blockRange(
  value: string,
  start: number,
  end: number,
): { blockStart: number; blockEnd: number; multiline: boolean } {
  const blockStart = lineStartAt(value, start)
  const lastOffset = end > start && lineStartAt(value, end) === end ? end - 1 : end
  const nextBreak = value.indexOf('\n', lastOffset)
  return {
    blockStart,
    blockEnd: nextBreak === -1 ? value.length : nextBreak,
    multiline: value.slice(start, end).includes('\n'),
  }
}

/** How many characters a dedent takes off the front of one line: one tab, or up
 * to one indent unit of spaces.
 *
 * "Up to" is the whole point — a line indented by a stray single space loses
 * that one space and stops, and a line with no indentation at all loses
 * nothing. A dedent that ate a non-whitespace character to make the numbers
 * work would be silent data loss. */
function dedentWidth(line: string, unit: string): number {
  if (line.startsWith('\t')) return 1
  let width = 0
  while (width < unit.length && line[width] === ' ') width++
  return width
}

/** Tab over a multi-line selection: one indent unit onto the front of every
 * line it touches, and the whole block left selected so the next Tab repeats.
 *
 * A blank line is skipped rather than filled with two spaces: indentation on a
 * line with nothing on it is trailing whitespace, which every linter in the
 * repo would then flag on a file the user only re-indented. */
function indentBlock(value: string, start: number, end: number, unit: string): EditResult {
  const { blockStart, blockEnd } = blockRange(value, start, end)
  const lines = value.slice(blockStart, blockEnd).split('\n')
  let added = 0
  const indented = lines.map((line) => {
    if (line === '') return line
    added += unit.length
    return unit + line
  })
  return {
    value: value.slice(0, blockStart) + indented.join('\n') + value.slice(blockEnd),
    selectionStart: blockStart,
    selectionEnd: blockEnd + added,
  }
}

/** Shift+Tab: take one indent unit off every line the selection touches — or,
 * with no selection at all, off the line the caret is on, which is the whole
 * reason this one path serves both.
 *
 * Answers `null` when there was nothing to remove, which hands the key back to
 * the browser as focus-previous. That is deliberate but it is *not* the escape
 * hatch, because the case it covers — a line with no indentation left — is
 * exactly the case that does not arise in a real source file. The hatch is
 * `tabEscapeAfter` below. */
function dedentBlock(
  value: string,
  start: number,
  end: number,
  unit: string,
): EditResult | null {
  const { blockStart, blockEnd, multiline } = blockRange(value, start, end)
  const lines = value.slice(blockStart, blockEnd).split('\n')
  let removed = 0
  let removedFirst = 0
  const dedented = lines.map((line, i) => {
    const width = dedentWidth(line, unit)
    removed += width
    if (i === 0) removedFirst = width
    return line.slice(width)
  })
  if (removed === 0) return null
  const next = value.slice(0, blockStart) + dedented.join('\n') + value.slice(blockEnd)
  if (multiline) {
    return { value: next, selectionStart: blockStart, selectionEnd: blockEnd - removed }
  }
  return {
    value: next,
    selectionStart: Math.max(blockStart, start - removedFirst),
    selectionEnd: Math.max(blockStart, end - removedFirst),
  }
}

/** Enter, carrying the current line's indentation onto the new one — plus one
 * more unit after an opening bracket, and the classic three-line expansion when
 * the caret sits between a matching pair.
 *
 * The plain case (no indentation to carry, no bracket) answers `null` on
 * purpose: a newline the browser inserts itself is one undo step of its own
 * making, and there is nothing this module would add to it. */
function autoIndent(
  value: string,
  start: number,
  end: number,
  unit: string,
): EditResult | null {
  const lineStart = lineStartAt(value, start)
  const before = value.slice(lineStart, start)
  const indent = before.match(/^[ \t]*/)?.[0] ?? ''
  const trimmed = before.replace(/\s+$/, '')
  const opener = trimmed.slice(-1)
  const opened = Object.prototype.hasOwnProperty.call(OPEN_PAIRS, opener)
  if (!opened && indent === '') return null
  const head = value.slice(0, start)
  const tail = value.slice(end)
  if (!opened) {
    return {
      value: head + '\n' + indent + tail,
      selectionStart: start + 1 + indent.length,
      selectionEnd: start + 1 + indent.length,
    }
  }
  const inner = indent + unit
  const caret = start + 1 + inner.length
  // Between `{` and its own `}`: the closer belongs on a line of its own at the
  // OUTER indent, or the block it closes reads as one level deeper than it is.
  if (OPEN_PAIRS[opener] === value[end]) {
    return {
      value: head + '\n' + inner + '\n' + indent + tail,
      selectionStart: caret,
      selectionEnd: caret,
    }
  }
  return { value: head + '\n' + inner + tail, selectionStart: caret, selectionEnd: caret }
}

/**
 * Whether typing `key` where the same character already sits should step past
 * it rather than insert one.
 *
 * The point of type-over is to make an auto-closed pair invisible: the user
 * types `)` out of habit and gets one `)`, not two. Answering that from "there
 * is a `)` under the caret" alone — which is what this did first — makes a
 * literal closer *untypable* wherever one already sits there: `foo)` with the
 * caret before the `)` could never become `foo))`, on a character every editor
 * lets you type.
 *
 * VS Code answers it from a record of which closers it inserted itself, kept on
 * the document and remapped through every subsequent edit. This module has no
 * document and no state — that is what makes it testable — so it asks the
 * question the tracking is a proxy for: **is the closer under the caret already
 * spoken for?**
 *
 * For a bracket that is an unmatched opener somewhere before the caret, scanned
 * back with a depth counter: `bar(|)` has one, so the `)` is stepped over;
 * `foo|)` has none, so a literal `)` is inserted. That covers the auto-closed
 * case exactly (the editor only ever auto-closes *after* inserting the opener)
 * without needing to know it was auto-closed.
 *
 * For a quote there is no opener/closer to tell apart, so the same question is
 * "is the caret inside a quoted run" — an odd number of that quote character
 * earlier on the line. `'a|'` steps over (the caret is inside the string and
 * that quote is its terminator); `x + |'b'` does not, so typing `'` in front of
 * an existing string no longer jumps silently into it, which is the case the
 * bare-character rule got wrong in the other direction.
 *
 * What happens *instead* there is not this function's answer, and is worth
 * stating because "does not step past" reads like "opens a pair" and is not:
 * the keystroke falls through to `bracket`, whose `CLOSE_BEFORE` test refuses to
 * open a pair in front of a `'`, so `editorKeyEdit` answers `null` and the
 * browser types one bare quote. Auto-closing in front of existing text is
 * exactly what that test exists to prevent, a lone quote is what a plain
 * textarea always gave, and the case is pinned by a test.
 *
 * Both are heuristics over text with no grammar behind them — a `(` inside a
 * comment votes like any other — which is the same standing every rule in this
 * module has, and the same one the character-under-the-caret rule had.
 */
function typeOverStepsPast(value: string, at: number, key: string): boolean {
  if (value[at] !== key) return false
  if (QUOTES.has(key)) {
    let seen = 0
    for (let i = at - 1; i >= 0 && value[i] !== '\n'; i--) {
      if (value[i] === key) seen++
    }
    return seen % 2 === 1
  }
  const open = CLOSE_PAIRS[key]
  if (open === undefined) return false
  let depth = 0
  for (let i = at - 1; i >= 0; i--) {
    if (value[i] === key) depth++
    else if (value[i] === open) {
      if (depth === 0) return true
      depth--
    }
  }
  return false
}

/** A printable bracket or quote: auto-close it, type over it, or wrap the
 * selection in it. Anything else is `null` — ordinary typing is the browser's.
 *
 * The three cases in the order they are decided:
 * - A non-empty selection surrounds rather than replaces. Replacing text with a
 *   single `(` is what a plain textarea does and it destroys the selection; the
 *   selection is the strongest statement of intent available, so it wins over
 *   both other cases.
 * - Typing the closer that is already sitting under the caret steps past it,
 *   when that closer is already spoken for (`typeOverStepsPast`). That is what
 *   makes an auto-closed pair invisible: the user types `)` anyway, out of
 *   habit, and gets one `)`, not two — while a `)` nothing opened is still
 *   typeable.
 * - Otherwise an opener (or a quote, which is its own closer) inserts the pair
 *   and puts the caret between them, subject to `CLOSE_BEFORE`. */
function bracket(value: string, start: number, end: number, key: string): EditResult | null {
  const isOpen = Object.prototype.hasOwnProperty.call(OPEN_PAIRS, key)
  const isQuote = QUOTES.has(key)
  if (start !== end) {
    if (!isOpen && !isQuote) return null
    const close = isQuote ? key : OPEN_PAIRS[key]
    return {
      value: value.slice(0, start) + key + value.slice(start, end) + close + value.slice(end),
      selectionStart: start + 1,
      selectionEnd: end + 1,
    }
  }
  if (typeOverStepsPast(value, start, key)) {
    return { value, selectionStart: start + 1, selectionEnd: start + 1 }
  }
  if (!isOpen && !isQuote) return null
  const next = value[start] ?? ''
  if (next !== '' && !CLOSE_BEFORE.test(next)) return null
  if (isQuote && WORD.test(value[start - 1] ?? '')) return null
  const close = isQuote ? key : OPEN_PAIRS[key]
  return {
    value: value.slice(0, start) + key + close + value.slice(start),
    selectionStart: start + 1,
    selectionEnd: start + 1,
  }
}

/** Backspace between the two halves of an empty pair takes both.
 *
 * Only when the pair is empty: `(x|)` deletes the `x` like anywhere else. This
 * is the exact inverse of what `bracket` inserted, so an auto-close the user
 * did not want costs one keystroke to undo. */
function deletePair(value: string, start: number, end: number): EditResult | null {
  if (start !== end || start === 0) return null
  const open = value[start - 1]
  const close = value[start]
  const matches = QUOTES.has(open) ? close === open : OPEN_PAIRS[open] === close
  if (!matches) return null
  return {
    value: value.slice(0, start - 1) + value.slice(start + 1),
    selectionStart: start - 1,
    selectionEnd: start - 1,
  }
}

/** The one entry point: what this keystroke does to the document, or `null` to
 * leave it to the browser.
 *
 * Offsets are clamped and ordered rather than trusted — they arrive from a DOM
 * node, and a stale pair read after the text shrank would otherwise slice
 * outside the string and produce a document nobody typed.
 *
 * `unit` is the file's own indentation (`detectIndentUnit`), passed in rather
 * than read here so this module stays a function of its arguments; a caller
 * with nothing to detect from omits it and gets `INDENT_UNIT`. */
export function editorKeyEdit(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  key: string,
  shiftKey: boolean,
  unit: string = INDENT_UNIT,
): EditResult | null {
  const a = clamp(selectionStart, value.length)
  const b = clamp(selectionEnd, value.length)
  const start = Math.min(a, b)
  const end = Math.max(a, b)
  if (key === 'Tab') {
    if (shiftKey) return dedentBlock(value, start, end, unit)
    if (blockRange(value, start, end).multiline) return indentBlock(value, start, end, unit)
    return {
      value: value.slice(0, start) + unit + value.slice(end),
      selectionStart: start + unit.length,
      selectionEnd: start + unit.length,
    }
  }
  if (key === 'Enter') return autoIndent(value, start, end, unit)
  if (key === 'Backspace') return deletePair(value, start, end)
  if (key.length === 1) return bracket(value, start, end, key)
  return null
}

/** Keys that are held rather than typed. They must not disarm the hatch below,
 * or Escape-then-**Shift**+Tab would be disarmed by the Shift itself. */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'])

/**
 * Whether the *next* Tab should move focus instead of indenting, given whether
 * it already should and the key that was just pressed.
 *
 * The editing keys above take Tab away from the browser, which on any indented
 * line takes away the last keyboard route out of the box: Tab inserts, and
 * Shift+Tab only falls through once there is nothing left to dedent. That is a
 * keyboard trap (WCAG 2.1.2), and it is worst on the Scripts page, where this
 * editor is one field of a form whose other controls sit below it and nothing
 * binds Escape at all.
 *
 * So Escape arms one Tab as a plain focus move — CodeMirror's and VS Code's
 * convention, and the one that costs nothing anywhere else: any other typed key
 * disarms it, so a user who presses Escape and keeps typing never notices, and
 * a caller that also acts on Escape (the Files tab discards the edit) is
 * unaffected because its editor is gone by then.
 */
export function tabEscapeAfter(armed: boolean, key: string): boolean {
  if (MODIFIER_KEYS.has(key)) return armed
  return key === 'Escape'
}

function clamp(offset: number, length: number): number {
  if (!Number.isFinite(offset)) return 0
  return Math.min(Math.max(Math.trunc(offset), 0), length)
}

/** The single contiguous edit that turns `before` into `after`, as the range to
 * replace and the text to put there.
 *
 * This exists for native undo, and nothing else. Assigning a textarea's `value`
 * wipes the browser's undo stack, so one Shift+Tab would cost the user every
 * earlier keystroke in the file; `document.execCommand('insertText')` keeps the
 * stack, but only ever replaces the current selection — so the caller has to
 * know which span to select first. Common prefix and suffix give exactly that,
 * and because every edit above is one insertion, one deletion or one
 * replacement of a contiguous run, the minimal span is always the real one. */
export function replacementRange(
  before: string,
  after: string,
): { start: number; end: number; text: string } {
  const shortest = Math.min(before.length, after.length)
  let prefix = 0
  while (prefix < shortest && before[prefix] === after[prefix]) prefix++
  let suffix = 0
  while (
    suffix < shortest - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++
  }
  return {
    start: prefix,
    end: before.length - suffix,
    text: after.slice(prefix, after.length - suffix),
  }
}
