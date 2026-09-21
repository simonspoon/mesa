// Which `{"resize":{cols,rows}}` frames are worth putting on the wire (mesa
// task 1290).
//
// Every geometry change — a divider drag, a split, an Auto Tile rebuild, a
// window resize, maximizing a pane — runs `ResizeObserver` → `fit.fit()` →
// `term.onResize` → a resize frame → `master.resize(...)` server-side, which
// is a real SIGWINCH to the live TUI on the other end. During a drag that is
// one per animation frame, and a TUI redrawing its input box under that storm
// is the reported stray blank lines. mesa injects no bytes on resize; the
// frames themselves are the storm.
//
// Debouncing is the component's (a timer is not a pure function). What lives
// here is the decision about a single candidate frame, so it is testable
// rather than inline in a `.tsx` — the repo's rule for logic worth testing.

export type PtyGeometry = { cols: number; rows: number }

/** The frame to send, or null to send nothing. */
export function nextResizeFrame(last: PtyGeometry | null, next: PtyGeometry): PtyGeometry | null {
  // `@xterm/addon-fit` clamps its own result with `Math.max(2, …)` /
  // `Math.max(1, …)`, so 2x1 is not a tiny terminal: it is the addon saying
  // the box it measured was degenerate (a pane mid-reparent, a container
  // with no layout yet). A NaN dimension is the same statement from a
  // measurement that did not happen at all. Neither is a geometry to tell a
  // TUI about — and neither floors any higher than xterm's own clamp, since
  // a minimum usable terminal size would be a policy this does not hold.
  if (!Number.isFinite(next.cols) || !Number.isFinite(next.rows)) return null
  if (next.cols <= 2 || next.rows <= 1) return null
  // A settled geometry re-announcing itself is a SIGWINCH that tells the TUI
  // nothing it does not already know — and every redundant one is a redraw.
  if (last && last.cols === next.cols && last.rows === next.rows) return null
  return { cols: next.cols, rows: next.rows }
}
