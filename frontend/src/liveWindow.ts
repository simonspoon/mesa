import type { LiveWindow } from './types/LiveWindow'

/**
 * Where the person's browser window sits on their desktop (mesa task 895).
 *
 * The agent can take a screenshot through `loki`, but only if it can say
 * *which* window to shoot — and picking the right one is the whole problem.
 * Several khora-launched headless Chromes report a window titled `"mesa"` too,
 * so a match on the title is as likely to photograph a headless browser as the
 * page the person is actually looking at. The box is what tells them apart: a
 * page's own `screenX`/`screenY`/`outerWidth`/`outerHeight` is exactly the
 * frame loki reports for that desktop window, and the *only* browser that
 * reports one here is the one joined to the conversation — a khora window
 * never reports, so it can never be picked.
 *
 * That is why the box is an **identity** and not a measurement: mesa does not
 * care how big the window is, only that these four numbers name one window on
 * one desktop. Which is also why they are rounded: loki reports the frame as
 * floats and the two ends are compared for equality, so a half-pixel would
 * make the page and the window that *is* the page disagree.
 *
 * Machine-local telemetry, in the same class as the route and the context: a
 * window box says where a rectangle is, and nothing whatever about what is
 * inside it.
 */

/** The four values a browser window knows about itself. Taken as an argument
 *  rather than read here so this module stays pure — the read of the real
 *  `window` belongs at the call site. */
export type WindowBoxSource = {
  screenX: number
  screenY: number
  outerWidth: number
  outerHeight: number
}

/** The box as it goes on the wire: whole pixels, because loki's frame is
 *  floats and mesa matches the two for equality. */
export function windowBox(source: WindowBoxSource): LiveWindow {
  return {
    x: Math.round(source.screenX),
    y: Math.round(source.screenY),
    width: Math.round(source.outerWidth),
    height: Math.round(source.outerHeight),
  }
}

/**
 * Whether two boxes are the same window in the same place. Field-by-field, the
 * twin of `sameContext`: the caller builds a fresh object every time it
 * samples, so identity would report an unmoved window on every tick.
 */
export function sameBox(a: LiveWindow | null, b: LiveWindow | null): boolean {
  if (a === null || b === null) return a === b
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}
