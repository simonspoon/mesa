import { useDeferredValue, useRef } from 'react'
import {
  SyntaxHighlighter,
  vscDarkPlus,
  highlightOverlaySource,
  prismGrammar,
} from '../syntaxHighlighter'

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
 * A language we carry no grammar for falls back to the plain textarea the
 * Files pane shipped with in task 327 — same rule as `FileCode`'s plain
 * `<pre>`.
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
}: {
  value: string
  language: string | null
  onChange: (next: string) => void
  /** Escape. Optional: a form with no discard action (the Scripts body box)
   * leaves the key to whatever owns the surrounding modal. */
  onCancel?: () => void
  /** Cmd/Ctrl+Enter. Optional for the same reason. */
  onSave?: () => void
  /** The Files tab opens this editor *as* the action, so it takes focus by
   * default. A form where it is one field among several (the Scripts body)
   * passes `false` so the form's own first field keeps the caret. */
  autoFocus?: boolean
}) {
  const highlightRef = useRef<HTMLDivElement>(null)
  // Re-tokenising a 256 KiB file on every keystroke would sit between the key
  // and the caret. Deferring lets React paint the typed character first and
  // recolour behind it, so the colours can lag a frame but the caret never
  // does.
  const deferred = useDeferredValue(value)
  const prismLanguage = prismGrammar(language)

  const textarea = (
    <textarea
      autoFocus={autoFocus}
      className="files-content-editor"
      value={value}
      spellCheck={false}
      wrap="off"
      onChange={(e) => onChange(e.target.value)}
      onScroll={(e) => {
        const layer = highlightRef.current
        if (layer === null) return
        layer.scrollTop = e.currentTarget.scrollTop
        layer.scrollLeft = e.currentTarget.scrollLeft
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && onCancel) onCancel()
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && onSave) onSave()
      }}
    />
  )

  if (prismLanguage === undefined) return textarea

  return (
    <div className="files-editor-stack">
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
      {textarea}
    </div>
  )
}
