// Global spatial focus navigation (mesa spec 449 story 454): h/j/k/l and the
// arrow keys move native DOM focus to the geometrically nearest focusable
// element in the pressed direction, computed from on-screen bounding boxes
// — not DOM/tab order. See .scratch/arch-449-keyboard.md §2 (candidate-set
// contract) and §3 (listener ownership).

import { useEffect } from 'react'
import { shouldIgnoreShortcut } from './keyboardScope'

type Direction = 'left' | 'right' | 'up' | 'down'

// Native focusability is the whole candidate contract (arch doc §2): any
// element already in the tab order. `tabindex="-1"` opts an element out —
// e.g. the kanban <li>'s dnd-kit-injected tabIndex, deliberately dead (see
// story 451's ADR 2); the nested <a> is the real candidate for cards.
const CANDIDATE_SELECTOR =
  'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'

// Matches on lowercase e.key only, same convention as the 'a' shortcut
// (story 452) — e.key's case follows Shift, and a shifted letter chord is
// not this feature's concern. Arrow key names don't change with Shift.
const KEY_DIRECTION: Record<string, Direction> = {
  h: 'left',
  ArrowLeft: 'left',
  l: 'right',
  ArrowRight: 'right',
  k: 'up',
  ArrowUp: 'up',
  j: 'down',
  ArrowDown: 'down',
}

interface Rect {
  left: number
  top: number
  right: number
  bottom: number
  cx: number
  cy: number
}

function toRect(el: Element): Rect {
  const r = el.getBoundingClientRect()
  return {
    left: r.left,
    top: r.top,
    right: r.right,
    bottom: r.bottom,
    cx: r.left + r.width / 2,
    cy: r.top + r.height / 2,
  }
}

// Visibility test (arch doc §2 leaves the exact test to the engineer):
// non-zero rect rules out display:none and detached elements; the computed
// `visibility` check additionally rules out panes kept mounted-but-hidden
// via `visibility: hidden` rather than unmounting — e.g. the inactive
// main/Terminal pane (App.tsx's `.main-slot-pane`, App.css:279) and the
// collapsed AgentSidebar body (App.css:2244) — both of which still report a
// positive-area rect since `visibility: hidden` preserves layout. Without
// this, focus() on such a candidate silently no-ops (the browser refuses
// to focus a non-visible element), dead-ending navigation in that direction.
function isVisible(el: Element): boolean {
  const r = el.getBoundingClientRect()
  if (r.width === 0 || r.height === 0) return false
  return getComputedStyle(el).visibility !== 'hidden'
}

function isDisabled(el: Element): boolean {
  return (
    'disabled' in el &&
    Boolean((el as unknown as { disabled: unknown }).disabled)
  )
}

function candidates(exclude: Element | null): Element[] {
  return Array.from(document.querySelectorAll(CANDIDATE_SELECTOR)).filter(
    (el) => el !== exclude && isVisible(el) && !isDisabled(el),
  )
}

// True when `rect` lies strictly in `dir` relative to `origin` — the
// direction filter every candidate must pass before it is scored. Edge
// comparison (not center comparison) so an element can't be "to the right"
// while still overlapping the origin on the primary axis.
function inDirection(dir: Direction, origin: Rect, rect: Rect): boolean {
  switch (dir) {
    case 'left':
      return rect.right <= origin.left
    case 'right':
      return rect.left >= origin.right
    case 'up':
      return rect.bottom <= origin.top
    case 'down':
      return rect.top >= origin.bottom
  }
}

// Gap between origin and candidate along the pressed axis (smaller = closer).
function primaryGap(dir: Direction, origin: Rect, rect: Rect): number {
  switch (dir) {
    case 'left':
      return origin.left - rect.right
    case 'right':
      return rect.left - origin.right
    case 'up':
      return origin.top - rect.bottom
    case 'down':
      return rect.top - origin.bottom
  }
}

// Positive when origin and candidate overlap on the axis perpendicular to
// `dir` — e.g. two kanban cards in the same row overlap vertically for a
// left/right move. Zero or negative means no shared row/column at all.
function perpOverlap(dir: Direction, origin: Rect, rect: Rect): number {
  if (dir === 'left' || dir === 'right') {
    return Math.min(origin.bottom, rect.bottom) - Math.max(origin.top, rect.top)
  }
  return Math.min(origin.right, rect.right) - Math.max(origin.left, rect.left)
}

function perpCenterDelta(dir: Direction, origin: Rect, rect: Rect): number {
  return dir === 'left' || dir === 'right'
    ? Math.abs(origin.cy - rect.cy)
    : Math.abs(origin.cx - rect.cx)
}

// Cold start (arch doc §2): nothing is focused yet, so there is no origin
// rect to measure from. Contract: focus the visible candidate nearest the
// viewport's top-left, regardless of which direction was pressed.
function nearestTopLeft(all: Element[]): Element | null {
  let best: Element | null = null
  let bestDist = Infinity
  for (const el of all) {
    const r = toRect(el)
    const dist = Math.hypot(r.left, r.top)
    if (dist < bestDist) {
      bestDist = dist
      best = el
    }
  }
  return best
}

// Two tiers, so a same-row/same-column neighbour always wins over a
// diagonal element that happens to sit numerically closer (spec req 15):
// first prefer candidates that share a row/column with the origin (real
// perpendicular-axis overlap), scored by the primary-axis gap alone; only
// when none exist, fall back to the nearest candidate overall, weighting
// perpendicular offset heavily so the fallback still favours alignment.
function nearestInDirection(
  dir: Direction,
  origin: Rect,
  all: Element[],
): Element | null {
  let bestAligned: Element | null = null
  let bestAlignedScore = Infinity
  let bestAny: Element | null = null
  let bestAnyScore = Infinity

  for (const el of all) {
    const rect = toRect(el)
    if (!inDirection(dir, origin, rect)) continue

    const gap = primaryGap(dir, origin, rect)
    const perp = perpCenterDelta(dir, origin, rect)
    const anyScore = gap + perp * 2
    if (anyScore < bestAnyScore) {
      bestAnyScore = anyScore
      bestAny = el
    }

    if (perpOverlap(dir, origin, rect) > 0) {
      // Tie-break within the aligned tier lightly by perpendicular offset,
      // so of two candidates at the same primary gap the more centered one
      // wins, without letting it override the primary gap itself.
      const alignedScore = gap + perp * 0.01
      if (alignedScore < bestAlignedScore) {
        bestAlignedScore = alignedScore
        bestAligned = el
      }
    }
  }

  return bestAligned ?? bestAny
}

/**
 * Move native focus to the nearest candidate in `dir` from
 * `document.activeElement` (or the viewport top-left on cold start). No
 * wrap-around: when nothing lies that way, focus stays put.
 */
export function moveFocus(dir: Direction): void {
  const active = document.activeElement
  const origin =
    active instanceof HTMLElement && active !== document.body ? active : null
  const all = candidates(origin)
  if (all.length === 0) return

  const target = origin
    ? nearestInDirection(dir, toRect(origin), all)
    : nearestTopLeft(all)

  if (target instanceof HTMLElement) target.focus()
}

/**
 * Mounts the global h/j/k/l + arrow-key spatial navigation listener (arch
 * doc §3) — a `window` keydown listener, bubble phase, with a key set
 * disjoint from the existing Cmd/Ctrl+Shift+P and 'a' shortcuts, so no
 * ordering coordination with either is required.
 */
export function useSpatialNav(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const dir = KEY_DIRECTION[e.key]
      if (!dir) return
      if (shouldIgnoreShortcut(e)) return
      e.preventDefault()
      moveFocus(dir)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
