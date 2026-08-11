import type { Ref } from 'react'
import { findSegments } from '../fileFind'
import type { FindMatch } from '../fileFind'

/** The find highlights, as an inert copy of the text laid over the real one
 * (task 809).
 *
 * There are two places that need this — the read-only pane, over Prism's
 * output, and the editor stack, over the coloured layer behind the textarea —
 * and they need the *same* thing: matches are never spliced into the markup
 * underneath (Prism's nested spans cut across match boundaries, and rewriting
 * that tree by offset is how colouring gets silently corrupted for one file),
 * so both paint a second `<pre>` of identical text with transparent glyphs and
 * let only the `<mark>` backgrounds show through. `aria-hidden`, because the
 * one readable, selectable copy of the file is the layer beneath.
 *
 * One component rather than the same dozen lines in both callers: the class
 * that marks the current match is the piece that would drift, and a highlight
 * that means "current" in one pane and not the other is exactly the kind of
 * bug neither pane's own tests would catch. Everything that varies — where the
 * layer sits, how it scrolls, what text it is given — stays with the caller,
 * which is why this takes a `className` and a `ref` instead of choosing them.
 */
export function FindLayer({
  text,
  matches,
  current,
  className,
  ref,
}: {
  /** Exactly the string the matches' offsets were computed against — the
   * alignment is by construction, so a caller that massages the text (the
   * editor's `highlightOverlaySource`) must massage this too. */
  text: string
  matches: FindMatch[]
  /** Which match is the one being stepped to, or -1. */
  current: number
  className: string
  /** The editor mirrors the textarea's scroll onto this element; the viewer
   * scrolls it with the pane and passes none. */
  ref?: Ref<HTMLPreElement>
}) {
  return (
    <pre className={className} ref={ref} aria-hidden="true">
      {findSegments(text, matches).map((seg, i) =>
        seg.match < 0 ? (
          <span key={i}>{seg.text}</span>
        ) : (
          <mark
            key={i}
            className={`files-find-hit${seg.match === current ? ' current' : ''}`}
          >
            {seg.text}
          </mark>
        ),
      )}
    </pre>
  )
}
