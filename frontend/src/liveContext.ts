import { useEffect, useRef } from 'react'
import type { LiveContext } from './types/LiveContext'

/**
 * What the person is looking at, on its way from the page that knows to the
 * hub that reports it (mesa task 888).
 *
 * The route alone says which page is open; it does not say what is *in focus*
 * on it — which file the editor holds, which diagram the canvas is showing,
 * which task the panel opened. That is the half a spoken conversation needs:
 * "rename this" is only answerable if mesa knows what "this" is.
 *
 * Why a module-level channel and not a prop or a context provider: `LiveHub`
 * is rendered inside `<header>` and is mounted for the life of the app, while
 * the pages are deep in the routed tree underneath it — there is no ancestor
 * the two share except `App`, and threading a setter down through every page,
 * tab and pane to reach one telemetry field would put a wire through the whole
 * tree for a value nothing in the tree reads. So the pages publish here and the
 * hub subscribes: **one poster, one report**. The hub stays the only thing that
 * talks to `/api/live/route`, exactly as it is the only thing that talks to
 * the rest of the live surface — mesa does not open a second write path.
 *
 * The channel is deliberately plain: a value, a setter and a subscriber list,
 * synchronous and dependency-free. The tested logic below it (normalize, equal)
 * is pure and knows nothing about React; only the hook at the bottom of the
 * file does.
 */

/**
 * The longest each field is reported at, mirroring
 * `core::store::LIVE_CONTEXT_FIELD_MAX` — the same duplication
 * `liveCapture.ts` makes against the auto-send bounds, so both ends name one
 * rule. The page clamps rather than letting the store refuse: a deeply nested
 * file path is a perfectly ordinary focus, and a report that is 422'd tells the
 * agent nothing at all, while a truncated one still names the page and most of
 * the path.
 */
export const CONTEXT_FIELD_MAX = 200

/**
 * One field as it is reported: trimmed, blank folded to `null` (an empty label
 * and no label are the same absence, and only one of them should reach the
 * agent), and cut to the bound with `…` marking the cut the way `task_name`
 * does — so a truncated value reads as truncated rather than as a path that
 * mysteriously ends mid-directory.
 */
function field(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (trimmed.length <= CONTEXT_FIELD_MAX) return trimmed
  return `${trimmed.slice(0, CONTEXT_FIELD_MAX - 1)}…`
}

/** A context as it goes on the wire. `null` — no focus to report — passes
 *  through unchanged; the `kind` is a closed vocabulary and is never touched. */
export function normalizeContext(ctx: LiveContext | null): LiveContext | null {
  if (ctx === null) return null
  return {
    kind: ctx.kind,
    id: field(ctx.id),
    label: field(ctx.label),
    detail: field(ctx.detail),
  }
}

/**
 * Whether two contexts say the same thing. Field-by-field, because every
 * caller builds a fresh object literal on every render: identity would report
 * the same focus over and over, which for ambient telemetry is pure noise.
 */
export function sameContext(a: LiveContext | null, b: LiveContext | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.kind === b.kind && a.id === b.id && a.label === b.label && a.detail === b.detail
  )
}

let current: LiveContext | null = null
const listeners = new Set<(ctx: LiveContext | null) => void>()

/** What the page last published, for the hub's first read — a subscriber that
 *  arrives after the page did must not have to wait for the next change. */
export function currentContext(): LiveContext | null {
  return current
}

/** Publish the focus. Normalized on the way in, and subscribers hear it only
 *  when it is genuinely different from what they were last told. */
export function setPageContext(ctx: LiveContext | null): void {
  const next = normalizeContext(ctx)
  if (sameContext(current, next)) return
  current = next
  for (const fn of listeners) fn(next)
}

/** Listen for the focus changing. Returns the unsubscribe. */
export function subscribeContext(fn: (ctx: LiveContext | null) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/**
 * Publish the focus and hand back exactly what was published — the normalized
 * value, which is what "mine" means to the publisher afterwards. A page keeps
 * this so it can tell later whether the standing context is still its own.
 */
export function publishContext(ctx: LiveContext | null): LiveContext | null {
  const next = normalizeContext(ctx)
  setPageContext(next)
  return next
}

/**
 * Clear the focus, but **only if what is standing is still what `published`
 * put there**.
 *
 * A page going away must not leave its last focus behind — the agent would
 * answer about a file nobody has open. But it must not clear blindly either:
 * on a route change React runs the arriving page's effect before the departing
 * page's cleanup, so a blind clear is the old page wiping the new page's
 * context. A publisher whose value has already been superseded simply stands
 * down; only the one still on the air turns it off.
 */
export function clearIfStanding(published: LiveContext | null): void {
  if (sameContext(current, published)) setPageContext(null)
}

// ---- the React half ----
//
// Everything above is pure and testable on its own; this is the one binding
// that makes a page a publisher.

/**
 * The hook a page calls with whatever it currently has in focus. It publishes
 * on change and **stands down on unmount** — a page that has gone is not what
 * the person is looking at, and leaving its last focus standing would have the
 * agent answering about a file nobody has open.
 *
 * The effect is keyed on the *value*, not the object: pages build their context
 * inline, so a bare object dep would re-run on every render. `sameContext` is
 * what makes that safe, and the serialized fields are what make it a dep React
 * can compare.
 *
 * Standing down is deliberately **conditional**, because the cleanup runs on
 * every change of that key and not only on unmount. Clearing unconditionally
 * would publish a transient "nothing selected" between every two focuses — and
 * since the hub debounces, a timer that happened to fire inside that gap would
 * tell the agent nothing is open at the exact moment the person changed what
 * they are looking at. The same hazard runs across a route swap, where the
 * arriving page's effect can run before the departing page's cleanup. So a
 * publisher only clears what is still *its own* value; one that has already
 * been superseded simply stops talking.
 */
export function useLiveContext(ctx: LiveContext | null): void {
  const key =
    ctx === null ? '' : JSON.stringify([ctx.kind, ctx.id, ctx.label, ctx.detail])
  const published = useRef<LiveContext | null>(null)
  useEffect(() => {
    published.current = publishContext(ctx)
    return () => clearIfStanding(published.current)
    // `ctx` is deliberately not a dep — `key` is its value, and the object
    // itself changes identity on every render of the page that owns it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}
