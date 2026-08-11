import {
  useDeferredValue,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react'
import type { CSSProperties, Ref } from 'react'
import {
  SyntaxHighlighter,
  vscDarkPlus,
  highlightOverlaySource,
  prismGrammar,
} from '../syntaxHighlighter'
import { caretPosition, gutterDigits, gutterText, lineCount } from '../editorStatus'
import type { CaretPosition } from '../editorStatus'
import {
  detectIndentUnit,
  editorKeyEdit,
  replacementRange,
  tabEscapeAfter,
} from '../editorInput'
import type { EditResult } from '../editorInput'
import { scrollLeftForBox, scrollTopForBox, scrollTopForLine } from '../fileFind'
import type { FindMatch } from '../fileFind'
import { FindLayer } from './FindLayer'

/** The few things an owner has to be able to *do* to the box rather than
 * describe about it (task 809's find bar): read where the caret is, put it
 * back, and reveal a range the user found. All three are imperative by
 * nature — a selection is DOM state that lives on the element, not a value a
 * re-render could restate — so they are an imperative handle rather than more
 * props, and the textarea ref stays private to this file either way. */
export interface CodeEditorHandle {
  /** The caret's offset, the anchor a fresh search starts from. */
  caretOffset(): number
  /** Return the caret to the code, without moving it. */
  focus(): void
  /** Select `[start, end)` and scroll it onto the screen. */
  reveal(start: number, end: number): void
}

/** The app's one syntax-highlighting text editor (task 658, lifted out of
 * FilesView in task 785): the same Prism colouring the read-only panes use,
 * but live under the caret.
 *
 * A `<textarea>` can only paint one colour, so the highlighted copy is a
 * separate, inert layer *behind* a transparent-text textarea — the standard
 * overlay editor. Everything that keeps the two aligned is load-bearing:
 * identical font metrics and zero padding on both (`.files-editor-*` in
 * App.css), `wrap="off"` so the textarea never soft-wraps where the `<pre>`
 * would not, `highlightOverlaySource` for the trailing-newline mismatch, and
 * scroll mirrored from the textarea onto the layer on every scroll event.
 * Only the textarea is a real control: the layer is `aria-hidden` and
 * pointer-transparent, so selection, the caret and the accessibility tree all
 * still come from the one element that holds the text.
 *
 * The line-number gutter (task 809) is a third layer of the same stack, driven
 * by the same mirrored scroll, `aria-hidden` and unselectable so a copy of the
 * code never carries line numbers with it. It is opaque and pinned over the left
 * edge of the textarea's own scrollport, which is what makes a long line scroll
 * *under* it rather than past it — and what both reveals into that box then have
 * to be told about, since the padding clearing the text is scrollable content
 * rather than a reserved strip: neither the browser's own caret reveal
 * (`scroll-padding-left`, in App.css beside that padding) nor this file's find
 * reveal (`scrollLeftForBox`'s lead-in) would otherwise leave the band clear,
 * and a caret parked under the numbers is text the user types and deletes
 * without seeing it. It is hidden outright while `wrap`
 * is on: a soft-wrapped logical line occupies several visual rows, so a gutter
 * numbering logical lines cannot stay beside them, and there is no measurement
 * this component could take that would not be a frame behind the typing. Hiding
 * it is the one solution that cannot desync — VS Code's alternative (numbering
 * visual rows) needs the browser to tell us where each wrap fell, which it
 * won't.
 *
 * "Wrap on means no line numbers" is therefore a known, deliberate gap rather
 * than an oversight, and the obvious fix does not apply here. Every editor that
 * keeps numbers under wrap gives each logical line its own grid row — a gutter
 * cell beside a code cell that is as tall as that line wrapped — which needs
 * the code split into one element per line. The code here is a single
 * `<textarea>`, one element by definition and the only thing holding the caret,
 * the selection and the undo stack; there is no per-line box to put in a row.
 * (The read-only pane has the same wall for a different reason: its code is one
 * Prism tree whose spans cut across line boundaries, and cutting it into rows
 * means rewriting somebody else's markup by offset — the thing `FindLayer`
 * exists to avoid.)
 *
 * A language we carry no grammar for falls back to a plain textarea in the same
 * stack — same gutter, no colours — matching `FileCode`'s plain `<pre>`.
 *
 * Find matches (task 809, slice 3) are a fourth layer of the same stack, on the
 * same terms: the offsets are decided by `fileFind.ts`, the layer only paints
 * them, and it exists rather than relying on the textarea's own selection
 * because the find bar keeps focus while stepping and an unfocused selection is
 * faint-to-invisible depending on the engine.
 *
 * The IDE editing behaviours (task 809) — Tab/Shift+Tab indent, Enter's
 * auto-indent and brace expansion, auto-closing and typing over a pair — are
 * decided entirely by `editorInput.ts`; this file only applies what it answers,
 * and `null` means the keystroke was never touched. Applying it goes through
 * `document.execCommand('insertText')` rather than an assignment, because
 * setting a textarea's value from script wipes the browser's undo stack: one
 * auto-indent would otherwise cost the user every keystroke typed before it.
 * `replacementRange` is what makes that possible — execCommand only ever
 * replaces the current selection, so the span to select first has to be derived
 * from the two documents. Where the command is refused (an old engine, a
 * non-browser test environment) the plain `onChange` is the fallback: correct
 * text, forfeited undo, never a dropped keystroke. Either way the caret is
 * restored in a layout effect, before the browser paints, so it never flashes
 * at the end of the line.
 *
 * Two things about those keys are the file's, not this repo's. The indent unit
 * is detected from the text being edited (`detectIndentUnit`), because this box
 * browses arbitrary repos — a fixed two spaces indents a four-space Rust file
 * wrongly and a tab-indented shell script *mixedly*. And because Tab is taken
 * from the browser, Escape arms the next Tab as a plain focus move
 * (`tabEscapeAfter`), the CodeMirror convention: without it the Scripts page's
 * body box — one field of a form, with no `onCancel` — has no forward-Tab out
 * of it at all, which is a keyboard trap rather than an editor.
 *
 * There is exactly one of these. Both callers (the Files tab's editor and the
 * Scripts page's shell-body box) mount it rather than forking the overlay
 * mechanics, because a copy that drifts a single CSS metric shears the
 * colours off the caret with nothing to catch it. */
export function CodeEditor({
  value,
  language,
  onChange,
  onCancel,
  onSave,
  autoFocus = true,
  wrap = false,
  onCaret,
  matches = [],
  current = -1,
  ref,
}: {
  value: string
  language: string | null
  onChange: (next: string) => void
  /** Escape. Optional: a form with no discard action (the Scripts body box)
   * leaves the key to whatever owns the surrounding modal. */
  onCancel?: () => void
  /** Cmd/Ctrl+Enter or Cmd/Ctrl+S. Optional for the same reason. */
  onSave?: () => void
  /** The Files tab opens this editor *as* the action, so it takes focus by
   * default. A form where it is one field among several (the Scripts body)
   * passes `false` so the form's own first field keeps the caret. */
  autoFocus?: boolean
  /** Soft-wrap long lines instead of scrolling sideways. Off by default: that
   * is what this editor shipped with, and the caller that offers the toggle
   * (the Files tab) is the one that persists the choice. */
  wrap?: boolean
  /** Where the caret is, on every move — for a status bar. Optional, because
   * only the Files tab has one. */
  onCaret?: (position: CaretPosition) => void
  /** Find matches over `value`, painted as a fourth layer of the stack.
   * Optional: only the Files tab has a find bar, and an empty list renders no
   * layer at all. */
  matches?: FindMatch[]
  /** Which of them is the one being stepped to, or -1. */
  current?: number
  /** The imperative handle above. A plain prop, which is all a `ref` is under
   * React 19 — no `forwardRef` wrapper, so the component stays a function of
   * its props for the caller that passes none (the Scripts body box). */
  ref?: Ref<CodeEditorHandle>
}) {
  const highlightRef = useRef<HTMLDivElement>(null)
  const gutterRef = useRef<HTMLPreElement>(null)
  const findRef = useRef<HTMLPreElement>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  // Where the caret has to end up once React has re-rendered with the edited
  // text. It cannot be set at keydown time: the value in the DOM is about to be
  // replaced, and any selection set against the old text would be discarded
  // with it.
  const pendingSelection = useRef<{ start: number; end: number } | null>(null)
  // Whether a step just happened and the view still owes it a scroll, under
  // soft wrap (see `reveal`). A ref, not state: it is the trace of an event,
  // and nothing renders differently for it.
  const pendingReveal = useRef(false)
  // Whether the next Tab is a plain focus move rather than an indent — armed by
  // Escape, disarmed by typing (`tabEscapeAfter`). A ref, not state: it changes
  // on keystrokes and nothing renders differently for it.
  const tabEscape = useRef(false)
  // Re-tokenising a 256 KiB file on every keystroke would sit between the key
  // and the caret. Deferring lets React paint the typed character first and
  // recolour behind it, so the colours can lag a frame but the caret never
  // does.
  const deferred = useDeferredValue(value)
  const prismLanguage = prismGrammar(language)
  // The gutter, unlike the colours, is NOT deferred: it is the ruler the text
  // is read against, and one that lagged a frame would show the wrong count for
  // the line just added. It is only a count and a join, not a tokeniser.
  //
  // Memoised on the COUNT rather than on `value`, though: the count changes
  // only when a newline is added or removed, while `value` changes on every
  // character, and rebuilding it there is one string per line plus a join plus
  // a full text-node replacement in the gutter <pre> on every keystroke of a
  // 10k-line file — paid while the deferred Prism pass is already running
  // behind it. The gutter stays exact either way; this only stops it being
  // rebuilt to the identical string.
  const lines = useMemo(() => lineCount(value), [value])
  const numbers = useMemo(() => gutterText(lines), [lines])
  // How *this* file is indented, re-read as it is edited rather than fixed at
  // mount: a file that starts empty (the Files tab's create) learns its
  // indentation from the first block typed into it. Bounded by
  // `detectIndentUnit`'s own line budget, so it costs the same on a 256 KiB file
  // as on a short one.
  const indentUnit = useMemo(() => detectIndentUnit(value), [value])

  function mirrorScroll(source: HTMLTextAreaElement) {
    const layer = highlightRef.current
    if (layer !== null) {
      layer.scrollTop = source.scrollTop
      layer.scrollLeft = source.scrollLeft
    }
    const finds = findRef.current
    if (finds !== null) {
      finds.scrollTop = source.scrollTop
      finds.scrollLeft = source.scrollLeft
    }
    // Vertically only: the gutter is pinned at the left edge, so the code
    // scrolls *under* it rather than dragging it off screen.
    const gutter = gutterRef.current
    if (gutter !== null) gutter.scrollTop = source.scrollTop
  }

  function reportCaret(source: HTMLTextAreaElement) {
    if (onCaret) onCaret(caretPosition(source.value, source.selectionStart))
  }

  /** Select a range and, if it is off screen, bring it back.
   *
   * Vertically with soft wrap off the scroll is arithmetic
   * (`scrollTopForLine`) rather than a `scrollIntoView`, because there is no
   * element to scroll to — the range is an offset inside a textarea — and it is
   * done here, synchronously, so it holds even when there is no find layer to
   * measure yet (the first character of a fresh query renders one for the first
   * time). It holds only while every logical line is one visual row, so under
   * soft wrap that half is left to the effect below.
   *
   * Everything *measured* — the wrapped vertical case, and sideways in both
   * modes — is left to that effect. Sideways cannot be arithmetic at all: a
   * column offset is not a pixel offset once a tab or a wide glyph is in the
   * line. And it cannot be left to the browser either, because this
   * deliberately does NOT focus (below), so nothing scrolls the selection into
   * view on its own: before this the counter stepped, the current-match class
   * moved and a match past the pane's right edge — a long import, a minified
   * file, any line past ~100 columns in a split pane — was simply never shown.
   * (The viewer scrolls to a real element, so it only needed the *lead-in* half
   * of the same answer; its gutter is sticky rather than absolute but covers the
   * left edge of its scrollport just as this one does, and `scrollIntoView`
   * knows nothing about either.)
   *
   * Deliberately does NOT focus: the caller (the find bar) needs the caret to
   * stay in its query box so Enter keeps stepping, and a textarea that grabbed
   * focus on every step would eat the next character typed. The selection is
   * still set, so `focus()` — which the bar calls when it closes — lands the
   * user on the match, ready to type over it; and the find layer is what makes
   * it *visible* in the meantime, since browsers paint an unfocused textarea's
   * selection faintly or not at all. */
  function reveal(start: number, end: number) {
    const area = areaRef.current
    if (area === null) return
    area.setSelectionRange(start, end)
    reportCaret(area)
    if (area.wrap === 'off') {
      area.scrollTop = scrollTopForLine(
        caretPosition(area.value, start).line,
        parseFloat(getComputedStyle(area).lineHeight),
        area.clientHeight,
        area.scrollTop,
      )
      // Assigning scrollTop fires `scroll` asynchronously, and the gutter and
      // the colours must not be a frame behind the selection they belong to.
      mirrorScroll(area)
    }
    // The measured half. The mark to measure does not exist in the DOM until
    // React has rendered the new index — on the first character of a query it
    // does not exist at all yet — so the call arms it and the effect below
    // performs it, the same shape as `pendingSelection`.
    pendingReveal.current = true
  }

  // The measured half of `reveal`, consuming what that call armed.
  //
  // Driven by that flag and NOT by a dependency list, which is the whole point:
  // `matches` is a fresh array on every keystroke (the owner re-searches the
  // draft), so an effect listing it re-ran while the user typed and yanked the
  // pane back to a match near the top of the file, one keystroke at a time,
  // with the caret they were typing at off screen. And `current` alone is not
  // enough either — stepping a single-match list is `(0 + 1) % 1 === 0`, so the
  // index a step lands on can legitimately be the one it left, which is exactly
  // the "the counter stepped and the view sat still" failure the measured
  // reveal exists to prevent. A step is an event, not a value, so it is
  // signalled as one; nothing else moves the view.
  useEffect(() => {
    if (!pendingReveal.current) return
    pendingReveal.current = false
    const area = areaRef.current
    const mark = findRef.current?.querySelector<HTMLElement>('.files-find-hit.current')
    if (area === null || mark == null) return
    // Wrapped only: unwrapped, `reveal` has already done this arithmetically,
    // and re-doing it from a measurement would be a second answer to the same
    // question.
    if (area.wrap !== 'off') {
      area.scrollTop = scrollTopForBox(
        mark.offsetTop,
        mark.offsetHeight,
        area.clientHeight,
        area.scrollTop,
      )
    }
    // Sideways in both modes. Wrapped there is nothing to scroll, so this is a
    // no-op there rather than a special case. The gutter is what the lead-in is
    // for: it paints over the left edge of the same box, so a match brought to
    // `scrollLeft` exactly would land under the numbers.
    //
    // The lead-in is the text layers' own `padding-left` rather than the
    // gutter's `offsetWidth`, which is the same number plus the 0.75rem channel
    // the padding already reserves — so a match revealed from the left arrives
    // with a column of code beside it instead of abutting the numbers, and the
    // find reveal and the browser's own caret reveal (`scroll-padding-left`, the
    // rule beside that padding in App.css) clear the gutter by the identical
    // amount. It is 0 under `.wrap`, where there is no gutter and no padding.
    area.scrollLeft = scrollLeftForBox(
      mark.offsetLeft,
      mark.offsetWidth,
      area.clientWidth,
      area.scrollLeft,
      parseFloat(getComputedStyle(area).paddingLeft),
    )
    // Same reason as in `reveal`: the `scroll` event is asynchronous and the
    // layers must not be a frame behind the match they are painting.
    // Unconditional, even when neither assignment moved anything — this is also
    // the moment a *newly mounted* find layer first has a scroll to mirror.
    mirrorScroll(area)
  })

  // A layer that appears while the textarea is already scrolled has no scroll
  // of its own, and nothing else would ever give it one: `mirrorScroll` runs
  // from the textarea's `scroll` event and from a reveal, and neither fires
  // when a *layer* mounts. Both conditional layers hit this. The find layer
  // mounts on the first match of a fresh query — searched from a caret 80 lines
  // down, its marks then painted lines 1-40's highlights over the text the user
  // is looking at, and the current match nowhere on screen; typing a second
  // character repaired it, which is what made it read as flaky rather than
  // broken. The gutter remounts when Wrap is turned off, showing 1..40 beside
  // line 500 — a line-number gutter that is silently, plausibly wrong.
  //
  // A layout effect, so the correction is applied before the browser paints the
  // frame the layer first appears in, and keyed on the two conditions that
  // mount a layer rather than on the values behind them.
  const hasFindLayer = matches.length > 0
  useLayoutEffect(() => {
    const area = areaRef.current
    if (area !== null) mirrorScroll(area)
  }, [hasFindLayer, wrap])

  // Rebuilt every render rather than memoised on `[]`: the methods close over
  // `onCaret`, and a handle frozen at mount would keep reporting the caret to
  // whatever callback the first render happened to carry.
  useImperativeHandle(ref, () => ({
    caretOffset: () => areaRef.current?.selectionStart ?? 0,
    focus: () => areaRef.current?.focus(),
    reveal,
  }))

  useLayoutEffect(() => {
    const target = pendingSelection.current
    const area = areaRef.current
    if (target === null || area === null) return
    pendingSelection.current = null
    area.setSelectionRange(target.start, target.end)
    reportCaret(area)
  })

  /** Put an `editorInput` answer into the textarea, undo stack intact. */
  function applyEdit(area: HTMLTextAreaElement, edit: EditResult) {
    const range = replacementRange(area.value, edit.value)
    // Typing over a closer moves the caret and nothing else. There is no
    // re-render to wait for, so the layout effect would never run.
    if (range.start === range.end && range.text === '') {
      area.setSelectionRange(edit.selectionStart, edit.selectionEnd)
      reportCaret(area)
      return
    }
    pendingSelection.current = { start: edit.selectionStart, end: edit.selectionEnd }
    area.setSelectionRange(range.start, range.end)
    // `insertText` with an empty string is a no-op in some engines, so a pure
    // deletion (a dedent, an emptied pair) asks for the delete command instead.
    const applied =
      range.text === ''
        ? document.execCommand('delete')
        : document.execCommand('insertText', false, range.text)
    // The command fires an `input` event, so React's own onChange has already
    // carried the new text up. Only the refusal path has to report it.
    if (!applied) onChange(edit.value)
  }

  const textarea = (
    <textarea
      autoFocus={autoFocus}
      ref={areaRef}
      className="files-content-editor"
      value={value}
      spellCheck={false}
      wrap={wrap ? 'soft' : 'off'}
      onChange={(e) => {
        onChange(e.target.value)
        reportCaret(e.target)
      }}
      // React's own select handling fires this for keyboard and pointer caret
      // moves alike, so it is the one listener a status bar needs beyond the
      // typing above.
      onSelect={(e) => reportCaret(e.currentTarget)}
      onScroll={(e) => mirrorScroll(e.currentTarget)}
      onKeyDown={(e) => {
        // Mid-composition, every key belongs to the IME. The Enter that
        // *commits* a candidate arrives here as a keydown with `key: 'Enter'`
        // and `isComposing: true`, and `autoIndent` answers non-null on any
        // indented line — so without this guard the composition is torn down
        // and a newline inserted in place of the character the user was
        // choosing. This is the one key IME users press most, and it is the
        // whole reason `editorInput.ts` can claim `null` keeps composition
        // intact.
        if (e.nativeEvent.isComposing) return
        // Escape arms one Tab as a plain focus move (`tabEscapeAfter`), which
        // is the keyboard route out of a box whose Tab is an indent. Read
        // before it is updated, so the Tab *after* the Escape is the one that
        // escapes.
        const escaping = tabEscape.current
        tabEscape.current = tabEscapeAfter(escaping, e.key)
        if (e.key === 'Escape' && onCancel) onCancel()
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && onSave) onSave()
        // Cmd/Ctrl+S is the reflex in every editor, and here it must be
        // swallowed as well as handled: the browser's own binding opens Save
        // Page, which offers to write an HTML copy of the app over the user's
        // file. `preventDefault` only fires when there is a save to do, so the
        // Scripts body box (no `onSave`) keeps the browser's behaviour rather
        // than silently eating the key.
        if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S') && onSave) {
          e.preventDefault()
          onSave()
        }
        // A modifier chord is someone else's shortcut — never an indent.
        if (e.metaKey || e.ctrlKey || e.altKey) return
        // The armed Tab: hand it straight back to the browser, which moves
        // focus the way it does in every other control on the page.
        if (escaping && e.key === 'Tab') return
        const area = e.currentTarget
        const edit = editorKeyEdit(
          area.value,
          area.selectionStart,
          area.selectionEnd,
          e.key,
          e.shiftKey,
          indentUnit,
        )
        if (edit === null) return
        e.preventDefault()
        applyEdit(area, edit)
      }}
    />
  )

  return (
    <div
      className={`files-editor-stack${prismLanguage === undefined ? '' : ' overlay'}${
        wrap ? ' wrap' : ' gutter'
      }`}
      // How wide the gutter has to be, in characters. It is absolutely
      // positioned, so it cannot size itself to its content the way the
      // viewer's does — and the padding that clears the text layers of it is a
      // second declaration that must agree. One custom property feeds both, so
      // a six-digit file widens the rail and moves the code together rather
      // than clipping `131072` down to a plausible `31072`.
      style={{ '--files-gutter-digits': gutterDigits(lines) } as CSSProperties}
    >
      {!wrap && (
        <pre className="files-editor-gutter" ref={gutterRef} aria-hidden="true">
          {numbers}
        </pre>
      )}
      {prismLanguage !== undefined && (
        <div className="files-editor-highlight" ref={highlightRef} aria-hidden="true">
          <SyntaxHighlighter
            language={prismLanguage}
            style={vscDarkPlus}
            customStyle={{
              margin: 0,
              padding: 0,
              background: 'transparent',
            }}
            codeTagProps={{ className: 'files-content-text' }}
          >
            {highlightOverlaySource(deferred)}
          </SyntaxHighlighter>
        </div>
      )}
      {matches.length > 0 && (
        // Find matches (task 809), painted over the colours and under the
        // caret. Literally the read-only pane's layer — one `FindLayer`, so
        // the two cannot disagree about which match is current — placed and
        // aligned by this stack's own rules: identical text through
        // `highlightOverlaySource` (so the trailing-newline mismatch is
        // handled once, the same way the colours are), identical metrics
        // inherited from the stack, and the same mirrored scroll. It is
        // what makes a match visible at all while focus stays in the query box
        // (see `reveal`): a background here shows through both the transparent
        // textarea and the coloured layer beneath it.
        <FindLayer
          className="files-editor-find"
          ref={findRef}
          text={highlightOverlaySource(value)}
          matches={matches}
          current={current}
        />
      )}
      {textarea}
    </div>
  )
}
