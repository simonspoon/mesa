// Pure logic for the CC session detail page (`#/cc/sessions/:id`) — ratios,
// formatting, chart series and the top-N rollup. It lives here rather than
// inline in CCSessionDetailView.tsx because these are exactly the predicates
// that ship wrong (a zero denominator, an empty series, a single bucket), and
// vitest covers this module while it cannot cover a `.tsx`.

import { shortModel } from './sessionGraph'
import type { Slice } from './components/charts'
import type { CcSessionBucket } from './types/CcSessionBucket'
import type { CcSessionThreadStat } from './types/CcSessionThreadStat'
import type { CcSessionToolStat } from './types/CcSessionToolStat'
import type { CcTokens } from './types/CcTokens'

/**
 * Token-type colours, shared by the dashboard's daily chart and legend and by
 * the detail page's composition donut. One definition so the two surfaces can
 * never disagree about which colour "cache write" is.
 */
export const TOK = {
  input: { label: 'input', color: 'var(--cyan)' },
  output: { label: 'output', color: 'var(--magenta)' },
  cache_read: { label: 'cache read', color: 'var(--green)' },
  cache_creation: { label: 'cache write', color: 'var(--amber)' },
} as const

export const fmtInt = (n: number) => n.toLocaleString()

export const fmtTok = (n: number) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(2)}B`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(2)}M`
      : n >= 1e3
        ? `${(n / 1e3).toFixed(1)}k`
        : `${n}`

export const fmtUsd = (n: number) =>
  n >= 1000 ? `$${(n / 1000).toFixed(2)}k` : `$${n.toFixed(2)}`

export const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`

/** Minutes → the coarsest unit that still reads: `45s` / `12m` / `2.4h`. */
export function fmtDuration(minutes: number): string {
  if (!(minutes > 0)) return '0m'
  if (minutes < 1) return `${Math.round(minutes * 60)}s`
  return minutes >= 60 ? `${(minutes / 60).toFixed(1)}h` : `${Math.round(minutes)}m`
}

/**
 * How much input context was served from the prompt cache:
 * `cache_read / (cache_read + input)`. A session with neither is 0, not NaN —
 * the KPI renders a number, so the guard belongs here.
 */
export function cacheHitRatio(t: CcTokens): number {
  const denom = t.cache_read + t.input
  return denom > 0 ? t.cache_read / denom : 0
}

/** Tokens per minute over the session span; 0 for a session with no span. */
export function tokensPerMinute(totalTokens: number, durationMinutes: number): number {
  return durationMinutes > 0 ? totalTokens / durationMinutes : 0
}

/**
 * The token-composition donut. Zero-valued types are dropped: a legend row
 * reading "cache write 0" is noise, and a zero slice draws nothing anyway. An
 * all-zero session yields no slices, which the page renders as a quiet empty.
 */
export function tokenSlices(t: CcTokens): Slice[] {
  return (
    [
      ['input', t.input],
      ['output', t.output],
      ['cache_read', t.cache_read],
      ['cache_creation', t.cache_creation],
    ] as const
  )
    .filter(([, v]) => v > 0)
    .map(([k, v]) => ({ label: TOK[k].label, value: v, color: TOK[k].color }))
}

/** One bucket field as a `Sparkbars` series, oldest→newest. */
export function bucketSeries(
  buckets: CcSessionBucket[],
  key: 'messages' | 'tool_calls' | 'total_tokens' | 'output_tokens',
): number[] {
  return buckets.map((b) => b[key])
}

/**
 * Top `n` tools by calls, with everything past them folded into one `other`
 * row so the bar list still adds up to the session's tool-call count. The
 * input is already sorted server-side (`calls` desc, `name` asc); this never
 * re-sorts, so the two surfaces agree on ties.
 */
export function topTools(tools: CcSessionToolStat[], n: number): CcSessionToolStat[] {
  if (tools.length <= n) return tools
  const head = tools.slice(0, n)
  const rest = tools.slice(n)
  return [
    ...head,
    {
      name: `other (${rest.length})`,
      calls: rest.reduce((s, t) => s + t.calls, 0),
      subagent_calls: rest.reduce((s, t) => s + t.subagent_calls, 0),
    },
  ]
}

// ---- Timeline by agent (the Gantt card) ----
//
// One row per thread on a shared time axis: the main thread first, then each
// subagent in start order. Every number the SVG needs is computed here rather
// than in the `.tsx`, because these are the predicates that ship wrong — a
// session with no span, a thread with no timestamps, a bar narrower than a
// pixel.

/** Geometry of the chart, in `viewBox` units. The label column is to the left
 *  of `x0`; the plot is `x0..x1`. */
export const TIMELINE = {
  width: 1000,
  /** Right edge of the right-anchored row labels. */
  labelRight: 160,
  x0: 170,
  x1: 980,
  gridTop: 20,
  /** Top of the first row's bar. */
  rowTop: 30,
  rowH: 44,
  barH: 22,
} as const

/** Total `viewBox` height for `n` rows: the plot, then a strip for the axis. */
export const timelineHeight = (n: number) => timelineGridBottom(n) + 30

/** Where the vertical grid lines stop — just below the last row's bar. */
export const timelineGridBottom = (n: number) =>
  TIMELINE.rowTop + TIMELINE.rowH * Math.max(n, 1) + 10

/** Top of row `i`'s bar. */
export const timelineRowY = (i: number) => TIMELINE.rowTop + TIMELINE.rowH * i

/**
 * Model colour for a timeline bar, keyed on the model *family* so every
 * generation of opus is one colour across the session (and across sessions).
 *
 * Two-part like `toolColor`: fixed slots for the families that actually ship,
 * drawn from the app's own palette so the card stays on-theme, and a hash over
 * a reserved tail for whatever ships next — a lookup table alone would hand a
 * new family the "unknown" grey. A thread with no model is grey, honestly.
 */
const MODEL_PALETTE = [
  'var(--cyan)', //   0 opus
  'var(--amber)', //  1 sonnet
  'var(--green)', //  2 haiku
  'var(--violet)', // 3 fable
  'hsl(206, 80%, 62%)', // 4 ── the hash's own band, below ──
  'hsl(340, 75%, 62%)', //  5
  'hsl(170, 58%, 48%)', //  6
  'hsl(276, 65%, 68%)', //  7
]
const MODEL_SLOT: Record<string, number> = { opus: 0, sonnet: 1, haiku: 2, fable: 3 }
/** The hash draws only from here up, so an unknown family can never land on a
 *  shipping one's colour. */
const MODEL_FALLBACK_FROM = 4

/** `claude-opus-5[1m]` → `opus`; the family is what a reader scans by. */
export function modelFamily(model: string | null): string | null {
  const short = shortModel(model)
  return short ? (short.split('-')[0] ?? short) : null
}

export function modelColor(model: string | null): string {
  const family = modelFamily(model)
  if (!family) return 'var(--muted)'
  const slot = MODEL_SLOT[family]
  if (slot !== undefined) return MODEL_PALETTE[slot]
  // FNV-1a, 32-bit — the same four lines `toolColor` uses.
  let h = 0x811c9dc5
  for (let i = 0; i < family.length; i++) {
    h ^= family.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return MODEL_PALETTE[
    MODEL_FALLBACK_FROM + ((h >>> 0) % (MODEL_PALETTE.length - MODEL_FALLBACK_FROM))
  ]
}

/** Epoch milliseconds for one of the payload's ISO-8601 UTC stamps; `null` for
 *  an absent or unparseable one, so a bad stamp is a missing bar, never a NaN
 *  coordinate. */
export function tsMs(iso: string | null): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

/** Main first, then the subagents in **start** order — not the token order the
 *  payload arrives in, which is what the Threads table wants. A thread with no
 *  start sorts last; `agent_id` breaks ties, so the order is total. */
export function timelineThreads(d: {
  main: CcSessionThreadStat
  agents: CcSessionThreadStat[]
}): CcSessionThreadStat[] {
  const agents = [...d.agents].sort((a, b) => {
    const sa = tsMs(a.start)
    const sb = tsMs(b.start)
    if (sa !== sb) {
      if (sa == null) return 1
      if (sb == null) return -1
      return sa - sb
    }
    return (a.agent_id ?? '').localeCompare(b.agent_id ?? '')
  })
  return [d.main, ...agents]
}

export type TimelineSpan = { from: number; to: number }

/** The axis the rows share: every thread's earliest start to its latest end.
 *  `null` when no thread has a usable stamp at all — the card then draws rows
 *  with no bars rather than dividing by zero. */
export function timelineSpanOf(threads: CcSessionThreadStat[]): TimelineSpan | null {
  let from: number | null = null
  let to: number | null = null
  for (const t of threads) {
    for (const ms of [tsMs(t.start), tsMs(t.end)]) {
      if (ms == null) continue
      from = from == null ? ms : Math.min(from, ms)
      to = to == null ? ms : Math.max(to, ms)
    }
  }
  return from == null || to == null ? null : { from, to }
}

/** Time → x, clamped to the plot. A span of no width collapses to its left
 *  edge rather than to Infinity. */
export function timelineX(ms: number, span: TimelineSpan): number {
  const width = span.to - span.from
  if (!(width > 0)) return TIMELINE.x0
  const r = (ms - span.from) / width
  return TIMELINE.x0 + Math.min(1, Math.max(0, r)) * (TIMELINE.x1 - TIMELINE.x0)
}

export type TimelineRect = { x: number; w: number }

/** A rect from `start` to `end`, at least 2 units wide so an instant still
 *  shows, and never spilling past the plot's right edge. */
function rect(startMs: number, endMs: number, span: TimelineSpan): TimelineRect {
  const x = timelineX(startMs, span)
  const w = Math.max(2, timelineX(endMs, span) - x)
  // Nudge left rather than shrink: an instant at the very end of the span
  // would otherwise be clamped to no width at all, i.e. invisible.
  return { x: Math.min(x, TIMELINE.x1 - w), w }
}

/** The thread's whole span as one rect; `null` when it has no start or no end —
 *  the row is still listed, with an em-dash where the bar would be. */
export function timelineBar(t: CcSessionThreadStat, span: TimelineSpan): TimelineRect | null {
  const start = tsMs(t.start)
  const end = tsMs(t.end)
  return start == null || end == null ? null : rect(start, end, span)
}

/** The thread's active stretches — drawn solid over the hatched whole-span
 *  background, so the gaps between them read as waiting. */
export function timelineSegments(t: CcSessionThreadStat, span: TimelineSpan): TimelineRect[] {
  const out: TimelineRect[] = []
  for (const i of t.active) {
    const start = tsMs(i.start)
    const end = tsMs(i.end)
    if (start == null || end == null) continue
    out.push(rect(start, end, span))
  }
  return out
}

/** `HH:MM` for an axis tick, read in UTC — the same clock the page's other
 *  stamps show, which are the payload's ISO strings sliced. */
export function clockLabel(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

/** `count` evenly spaced ticks across the span, both ends inclusive. A span of
 *  no width yields a single tick, not `count` copies of one instant. */
export function timelineTicks(
  span: TimelineSpan,
  count = 6,
): { x: number; label: string; ms: number }[] {
  const n = Math.max(2, count)
  if (!(span.to > span.from)) {
    return [{ x: TIMELINE.x0, label: clockLabel(span.from), ms: span.from }]
  }
  return Array.from({ length: n }, (_, i) => {
    const ms = span.from + ((span.to - span.from) * i) / (n - 1)
    return { x: timelineX(ms, span), label: clockLabel(ms), ms }
  })
}

/** Seconds inside the thread's own active stretches. */
export function activeSeconds(t: CcSessionThreadStat): number {
  let total = 0
  for (const i of t.active) {
    const start = tsMs(i.start)
    const end = tsMs(i.end)
    if (start == null || end == null) continue
    total += (end - start) / 1000
  }
  return total
}

/** Seconds of the thread's span that fall in no active stretch — the gaps the
 *  card hatches. Never negative. */
export function waitingSeconds(t: CcSessionThreadStat): number {
  const start = tsMs(t.start)
  const end = tsMs(t.end)
  if (start == null || end == null) return 0
  return Math.max(0, (end - start) / 1000 - activeSeconds(t))
}

/** The thread's whole span in minutes; 0 when it has no usable stamps. */
export function threadMinutes(t: CcSessionThreadStat): number {
  const start = tsMs(t.start)
  const end = tsMs(t.end)
  return start == null || end == null ? 0 : Math.max(0, (end - start) / 60000)
}

/** Approximate width of one character of the card's 12-unit label text, in
 *  `viewBox` units. SVG cannot measure text without a layout pass, and every
 *  placement below is a decision about whether a string *fits* — so the width
 *  is estimated, slightly generously, and every budget is compared against it.
 *  Over-estimating costs a truncated description; under-estimating costs the
 *  overprinting this const exists to prevent. */
const NOTE_CHAR_W = 6.4
/** Clearance between a bar and a note placed beside it. */
const NOTE_GAP = 6
/** Inset of a note placed *inside* a bar. */
const NOTE_PAD = 6

const noteWidth = (text: string) => text.length * NOTE_CHAR_W

/** `<duration> · <description>`, trimmed to `budget` units. The duration is
 *  never dropped — it is the number the row is read for — so a budget that
 *  cannot even hold it is `null` rather than a lie. */
function fitNote(head: string, desc: string | null, budget: number): string | null {
  if (noteWidth(head) > budget) return null
  if (!desc) return head
  const full = `${head} · ${desc}`
  if (noteWidth(full) <= budget) return full
  // One character of the budget goes to the ellipsis; below a couple of
  // readable characters the description says nothing, so drop it outright.
  const room = Math.floor(budget / NOTE_CHAR_W) - head.length - 3 - 1
  return room >= 3 ? `${head} · ${desc.slice(0, room)}…` : head
}

export type TimelineNote = {
  x: number
  anchor: 'start' | 'end'
  text: string
  /** Drawn over the bar itself rather than beside it — the caller flips the
   *  text colour for contrast against the bar's fill. */
  inside: boolean
}

/**
 * Where a subagent row's note goes, and what it says.
 *
 * The invariant this function exists to hold: **a note never renders left of
 * `TIMELINE.x0`, and so never enters the row-label gutter.** The old rule put
 * a long note left of the bar unclamped, which on a bar spanning most of the
 * plot printed the text off the card's own left edge and over the row label.
 *
 * Three candidate slots, each with a budget in `viewBox` units: after the bar,
 * before it, and inside it. The full note goes in the first *outside* slot it
 * fits — reading beside the bar is easier than reading over it — and otherwise
 * it is truncated into whichever of the three is widest, which for a bar that
 * fills the plot is the bar itself. A bar too narrow to hold even the duration
 * gets no note at all rather than an overflowing one.
 */
export function timelineNotePlacement(
  t: CcSessionThreadStat,
  bar: TimelineRect,
): TimelineNote | null {
  const head = fmtDuration(threadMinutes(t))
  const desc = t.description?.trim() || null
  const full = desc ? `${head} · ${desc}` : head

  const right = {
    x: bar.x + bar.w + NOTE_GAP,
    anchor: 'start' as const,
    inside: false,
    budget: TIMELINE.x1 - (bar.x + bar.w + NOTE_GAP),
  }
  const left = {
    x: bar.x - NOTE_GAP,
    anchor: 'end' as const,
    inside: false,
    budget: bar.x - NOTE_GAP - TIMELINE.x0,
  }
  const inside = {
    x: bar.x + NOTE_PAD,
    anchor: 'start' as const,
    inside: true,
    budget: bar.w - NOTE_PAD * 2,
  }

  for (const slot of [right, left]) {
    if (noteWidth(full) <= slot.budget) {
      return { x: slot.x, anchor: slot.anchor, text: full, inside: slot.inside }
    }
  }
  const widest = [right, left, inside].reduce((a, b) => (b.budget > a.budget ? b : a))
  const text = fitNote(head, desc, widest.budget)
  return text == null
    ? null
    : { x: widest.x, anchor: widest.anchor, text, inside: widest.inside }
}

/** The widest stretch of a thread's bar that no active segment covers — the
 *  hatch a reader actually sees. `null` when the segments cover the bar, or
 *  when the widest gap is too thin to be worth naming. */
export function largestWaitingGap(
  t: CcSessionThreadStat,
  span: TimelineSpan,
): TimelineRect | null {
  const bar = timelineBar(t, span)
  if (bar == null) return null
  const segs = timelineSegments(t, span)
  let best: TimelineRect | null = null
  let cursor = bar.x
  for (const s of [...segs, { x: bar.x + bar.w, w: 0 }]) {
    const w = s.x - cursor
    if (w >= 1 && (best == null || w > best.w)) best = { x: cursor, w }
    cursor = Math.max(cursor, s.x + s.w)
  }
  return best
}

/**
 * The `waiting on subagents, …` label on the main row: centred in the
 * **largest** waiting gap, and only when that gap is wide enough to hold it.
 *
 * It used to sit at the bar's midpoint, which on a real session printed it
 * straight over two solid active rects. Omitting it costs nothing — the hint
 * line above the chart already states the same total, in the same units, from
 * the same `fmtDuration`.
 */
export function waitingLabelPlacement(
  t: CcSessionThreadStat,
  span: TimelineSpan,
): { x: number; text: string } | null {
  const waiting = waitingSeconds(t) / 60
  if (waiting < 1) return null
  const gap = largestWaitingGap(t, span)
  if (gap == null) return null
  const text = `waiting on subagents, ${fmtDuration(waiting)}`
  return noteWidth(text) + NOTE_PAD * 2 > gap.w ? null : { x: gap.x + gap.w / 2, text }
}

/** One swatch per model actually present, in row order. The "waiting" swatch
 *  is the hatch and is added by the component — but only when
 *  [`largestWaitingGap`] says some of it is actually drawn. */
export function timelineLegend(threads: CcSessionThreadStat[]): { label: string; color: string }[] {
  const seen = new Set<string>()
  const out: { label: string; color: string }[] = []
  for (const t of threads) {
    const label = shortModel(t.model)
    if (!label || seen.has(label)) continue
    seen.add(label)
    out.push({ label, color: modelColor(t.model) })
  }
  return out
}

/** The sentence above the chart: how much there is to look at, and what the
 *  main row's two textures mean. */
export function timelineHint(threads: CcSessionThreadStat[], durationMinutes: number): string {
  const n = threads.length
  const head = `${n} thread${n === 1 ? '' : 's'} over ${fmtDuration(durationMinutes)}.`
  const main = threads[0]
  if (!main) return head
  const waiting = waitingSeconds(main) / 60
  const active = activeSeconds(main) / 60
  return waiting >= 1
    ? `${head} Main was active for ${fmtDuration(active)} and waited ${fmtDuration(waiting)} on its subagents.`
    : `${head} Main was working throughout.`
}
