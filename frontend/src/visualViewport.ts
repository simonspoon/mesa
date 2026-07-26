import { useEffect } from 'react'

/**
 * Publishes the *visual* viewport's height as `--visual-viewport-height` on
 * `<html>` (mesa task 560).
 *
 * Why a second viewport unit exists at all: `100dvh` (mesa task 555, the
 * `#root` lock in `index.css`) tracks the browser's own dynamic toolbars, and
 * that is the only thing it tracks. An on-screen keyboard does **not** resize
 * the layout viewport on iOS Safari or Android Chrome — it shrinks the
 * *visual* viewport and leaves `dvh` exactly where it was. So a keyboard opens
 * over the bottom of a `100dvh` shell, and on a terminal that bottom is the
 * shell prompt: you type into a line you cannot see.
 *
 * `window.visualViewport.height` is the one number that reports this, hence
 * the var. It is set unconditionally at every width — the phone block in
 * `App.css` is the only place that *reads* it, so the breakpoint still lives
 * in CSS alone (the same rule `FilesView`'s `treeOpen` follows). Above the
 * phone tier the var is written and ignored.
 *
 * Deliberately **height only.** `visualViewport` also exposes `offsetTop`,
 * which is non-zero when the browser scrolls the layout viewport to keep a
 * focused input above the keyboard, and a matching translate is the usual
 * companion fix. It is not here because it could not be verified: the
 * measurement rig for this task drives Chrome with a synthetic
 * `visualViewport` resize, which reproduces the height change faithfully and
 * the scroll-to-focus behaviour not at all. See `docs/mobile.md`'s known-gaps
 * note rather than assuming it is handled.
 *
 * Updates are coalesced into one `requestAnimationFrame` per burst: iOS emits
 * a stream of `resize`/`scroll` events through the keyboard's slide-in
 * animation, and every one of them would otherwise resize every open xterm —
 * exactly the `{"resize":…}` storm mesa task 552 fixed at the CSS layer.
 */
export function useVisualViewportHeightVar(): void {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    let frame = 0
    const apply = () => {
      frame = 0
      document.documentElement.style.setProperty(
        '--visual-viewport-height',
        `${Math.round(vv.height)}px`,
      )
    }
    const schedule = () => {
      if (frame !== 0) return
      frame = requestAnimationFrame(apply)
    }
    apply()
    vv.addEventListener('resize', schedule)
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      vv.removeEventListener('resize', schedule)
      document.documentElement.style.removeProperty('--visual-viewport-height')
    }
  }, [])
}
