import { describe, expect, it } from 'vitest'
import {
  TIMELINE,
  activeSeconds,
  bucketSeries,
  cacheHitRatio,
  clockLabel,
  fmtDuration,
  modelColor,
  modelFamily,
  timelineBar,
  timelineHeight,
  timelineHint,
  timelineLegend,
  timelineNotePlacement,
  timelineSegments,
  timelineSpanOf,
  timelineThreads,
  timelineTicks,
  timelineX,
  tokenSlices,
  tokensPerMinute,
  topTools,
  tsMs,
  waitingLabelPlacement,
  waitingSeconds,
  largestWaitingGap,
} from './sessionDetail'
import type { CcSessionBucket } from './types/CcSessionBucket'
import type { CcSessionThreadStat } from './types/CcSessionThreadStat'
import type { CcSessionToolStat } from './types/CcSessionToolStat'
import type { CcTokens } from './types/CcTokens'

const tok = (p: Partial<CcTokens> = {}): CcTokens => ({
  input: 0,
  output: 0,
  cache_read: 0,
  cache_creation: 0,
  ...p,
})

const bucket = (p: Partial<CcSessionBucket> = {}): CcSessionBucket => ({
  start: '2026-06-15T01:00:00Z',
  messages: 0,
  tool_calls: 0,
  total_tokens: 0,
  output_tokens: 0,
  ...p,
})

const tool = (name: string, calls: number, subagent_calls = 0): CcSessionToolStat => ({
  name,
  calls,
  subagent_calls,
})

describe('cacheHitRatio', () => {
  it('is the cached share of input context', () => {
    expect(cacheHitRatio(tok({ input: 100, cache_read: 300 }))).toBeCloseTo(0.75)
  })
  it('is 0, never NaN, when nothing was read at all', () => {
    expect(cacheHitRatio(tok())).toBe(0)
    expect(cacheHitRatio(tok({ output: 500 }))).toBe(0)
  })
})

describe('tokensPerMinute', () => {
  it('divides over the span', () => {
    expect(tokensPerMinute(600, 2)).toBe(300)
  })
  it('is 0 for a session with no span', () => {
    expect(tokensPerMinute(600, 0)).toBe(0)
    expect(tokensPerMinute(600, -1)).toBe(0)
  })
})

describe('fmtDuration', () => {
  it('picks the coarsest unit that still reads', () => {
    expect(fmtDuration(0.5)).toBe('30s')
    expect(fmtDuration(12)).toBe('12m')
    expect(fmtDuration(144)).toBe('2.4h')
  })
  it('renders a zero/absent span as 0m', () => {
    expect(fmtDuration(0)).toBe('0m')
    expect(fmtDuration(-3)).toBe('0m')
  })
})

describe('tokenSlices', () => {
  it('keeps the four token types in composition order', () => {
    const s = tokenSlices(tok({ input: 1, output: 2, cache_read: 3, cache_creation: 4 }))
    expect(s.map((x) => x.label)).toEqual(['input', 'output', 'cache read', 'cache write'])
    expect(s.map((x) => x.value)).toEqual([1, 2, 3, 4])
    // Colours are distinct, so the legend can be read off the donut.
    expect(new Set(s.map((x) => x.color)).size).toBe(4)
  })
  it('drops zero-valued types rather than drawing empty legend rows', () => {
    expect(tokenSlices(tok({ input: 5 })).map((x) => x.label)).toEqual(['input'])
    expect(tokenSlices(tok())).toEqual([])
  })
})

describe('bucketSeries', () => {
  it('projects one field, oldest→newest', () => {
    const b = [bucket({ tool_calls: 1 }), bucket({ tool_calls: 0 }), bucket({ tool_calls: 5 })]
    expect(bucketSeries(b, 'tool_calls')).toEqual([1, 0, 5])
  })
  it('handles the empty and one-bucket cases', () => {
    expect(bucketSeries([], 'total_tokens')).toEqual([])
    expect(bucketSeries([bucket({ total_tokens: 42 })], 'total_tokens')).toEqual([42])
  })
})

describe('topTools', () => {
  it('passes a short list through untouched', () => {
    const t = [tool('Bash', 3), tool('Read', 1)]
    expect(topTools(t, 12)).toEqual(t)
    expect(topTools([], 12)).toEqual([])
  })
  it('folds the tail into one row that keeps the totals honest', () => {
    const t = [tool('Bash', 10), tool('Read', 5), tool('Edit', 3, 1), tool('Grep', 2, 2)]
    const out = topTools(t, 2)
    expect(out.map((x) => x.name)).toEqual(['Bash', 'Read', 'other (2)'])
    expect(out.reduce((s, x) => s + x.calls, 0)).toBe(20)
    expect(out[2].subagent_calls).toBe(3)
  })
})

// ---- Timeline by agent ----

const thread = (p: Partial<CcSessionThreadStat> = {}): CcSessionThreadStat => ({
  agent_id: null,
  agent: null,
  skill: null,
  description: null,
  spawn_depth: null,
  model: null,
  messages: 0,
  tool_calls: 0,
  tokens: tok(),
  total_tokens: 0,
  est_cost_usd: 0,
  start: null,
  end: null,
  active: [],
  ...p,
})

/** Minutes past a fixed 01:00 UTC, as one of the payload's ISO stamps — so an
 *  offset reads as plain arithmetic in a fixture and `at(60)` is 02:00, not an
 *  unparseable minute 60. */
const T0 = Date.parse('2026-06-15T01:00:00Z')
const at = (min: number, sec = 0) =>
  new Date(T0 + min * 60_000 + sec * 1_000).toISOString().replace('.000Z', 'Z')

describe('modelColor', () => {
  it('is one colour per model family, whatever the generation or suffix', () => {
    expect(modelFamily('claude-opus-5[1m]')).toBe('opus')
    expect(modelColor('claude-opus-5[1m]')).toBe(modelColor('claude-opus-4-8'))
    expect(modelColor('claude-sonnet-5')).not.toBe(modelColor('claude-opus-5'))
  })
  it('gives an unshipped family a real colour, never a shipping one', () => {
    const shipping = ['opus', 'sonnet', 'haiku', 'fable'].map((m) => modelColor(`claude-${m}-5`))
    const unknown = modelColor('claude-quartz-1')
    expect(unknown).toBeTruthy()
    expect(shipping).not.toContain(unknown)
  })
  it('is a quiet grey for a thread with no model at all', () => {
    expect(modelColor(null)).toBe('var(--muted)')
  })
})

describe('tsMs', () => {
  it('is null rather than NaN for an absent or unparseable stamp', () => {
    expect(tsMs(null)).toBeNull()
    expect(tsMs('not a date')).toBeNull()
    expect(tsMs(at(5))).toBe(Date.parse(at(5)))
  })
})

describe('timelineThreads', () => {
  it('puts main first and the subagents in start order, not token order', () => {
    const d = {
      main: thread({ start: at(0), end: at(50) }),
      // Arrives token-desc, which is the Threads table's order.
      agents: [
        thread({ agent_id: 'b', total_tokens: 900, start: at(20) }),
        thread({ agent_id: 'a', total_tokens: 100, start: at(5) }),
      ],
    }
    expect(timelineThreads(d).map((t) => t.agent_id)).toEqual([null, 'a', 'b'])
  })
  it('sorts a thread with no start last, ties broken by agent_id', () => {
    const d = {
      main: thread(),
      agents: [
        thread({ agent_id: 'z' }),
        thread({ agent_id: 'c', start: at(9) }),
        thread({ agent_id: 'y' }),
      ],
    }
    expect(timelineThreads(d).map((t) => t.agent_id)).toEqual([null, 'c', 'y', 'z'])
  })
})

describe('timelineSpanOf', () => {
  it('spans every thread, earliest start to latest end', () => {
    const span = timelineSpanOf([
      thread({ start: at(10), end: at(20) }),
      thread({ start: at(5), end: at(40) }),
    ])
    expect(span).toEqual({ from: Date.parse(at(5)), to: Date.parse(at(40)) })
  })
  it('is null when no thread carries a usable stamp', () => {
    expect(timelineSpanOf([thread(), thread()])).toBeNull()
    expect(timelineSpanOf([])).toBeNull()
  })
})

describe('timelineX', () => {
  const span = { from: 0, to: 1000 }
  it('maps the span onto the plot, ends included', () => {
    expect(timelineX(0, span)).toBe(TIMELINE.x0)
    expect(timelineX(1000, span)).toBe(TIMELINE.x1)
    expect(timelineX(500, span)).toBeCloseTo((TIMELINE.x0 + TIMELINE.x1) / 2)
  })
  it('clamps rather than running off the plot', () => {
    expect(timelineX(-5000, span)).toBe(TIMELINE.x0)
    expect(timelineX(9e9, span)).toBe(TIMELINE.x1)
  })
  it('collapses a zero-width span to the left edge, never to Infinity', () => {
    expect(timelineX(7, { from: 7, to: 7 })).toBe(TIMELINE.x0)
  })
})

describe('timelineBar / timelineSegments', () => {
  const span = { from: Date.parse(at(0)), to: Date.parse(at(60)) }
  it('is null for a thread with no start or no end — the row still lists', () => {
    expect(timelineBar(thread(), span)).toBeNull()
    expect(timelineBar(thread({ start: at(1) }), span)).toBeNull()
    expect(timelineSegments(thread(), span)).toEqual([])
  })
  it('keeps an instant visible and never spills past the right edge', () => {
    const bar = timelineBar(thread({ start: at(60), end: at(60) }), span)
    expect(bar?.w).toBe(2)
    expect((bar?.x ?? 0) + (bar?.w ?? 0)).toBeLessThanOrEqual(TIMELINE.x1)
  })
  it('draws one rect per active stretch', () => {
    const t = thread({
      start: at(0),
      end: at(60),
      active: [
        { start: at(0), end: at(10) },
        { start: at(50), end: at(60) },
      ],
    })
    const segs = timelineSegments(t, span)
    expect(segs).toHaveLength(2)
    expect(segs[0].x).toBe(TIMELINE.x0)
    expect(segs[1].x + segs[1].w).toBeLessThanOrEqual(TIMELINE.x1)
  })
})

describe('timelineTicks', () => {
  it('lays six labelled ticks across the span, both ends inclusive', () => {
    const ticks = timelineTicks({ from: Date.parse(at(0)), to: Date.parse(at(50)) })
    expect(ticks).toHaveLength(6)
    expect(ticks[0].x).toBe(TIMELINE.x0)
    expect(ticks[5].x).toBe(TIMELINE.x1)
    expect(ticks.map((t) => t.label)).toEqual([
      '01:00',
      '01:10',
      '01:20',
      '01:30',
      '01:40',
      '01:50',
    ])
  })
  it('is one tick for a session with no span, not six copies of one instant', () => {
    const ms = Date.parse(at(3))
    expect(timelineTicks({ from: ms, to: ms })).toEqual([
      { x: TIMELINE.x0, label: '01:03', ms },
    ])
  })
})

describe('clockLabel', () => {
  it('reads UTC, the clock the rest of the page shows', () => {
    expect(clockLabel(Date.parse('2026-06-15T09:07:00Z'))).toBe('09:07')
  })
})

describe('activeSeconds / waitingSeconds', () => {
  const t = thread({
    start: at(0),
    end: at(60),
    active: [
      { start: at(0), end: at(10) },
      { start: at(55), end: at(60) },
    ],
  })
  it('sums the stretches, and the rest of the span is the wait', () => {
    expect(activeSeconds(t)).toBe(15 * 60)
    expect(waitingSeconds(t)).toBe(45 * 60)
  })
  it('never goes negative, and is 0 for a thread with no stamps', () => {
    expect(waitingSeconds(thread())).toBe(0)
    expect(waitingSeconds(thread({ start: at(0), end: at(1), active: [{ start: at(0), end: at(9) }] }))).toBe(0)
  })
})

describe('timelineNotePlacement', () => {
  const run = (p: Partial<CcSessionThreadStat>) =>
    thread({ agent_id: 'a', start: at(0), end: at(10), ...p })

  it('puts the whole note after the bar when there is room', () => {
    const note = timelineNotePlacement(run({ description: 'Review backend diff' }), {
      x: 200,
      w: 40,
    })
    expect(note).toEqual({
      x: 246,
      anchor: 'start',
      text: '10m · Review backend diff',
      inside: false,
    })
  })

  it('falls back to before the bar, but only where the whole note fits there', () => {
    // Bar 700..960: 14 units to the right, 524 to the left.
    const note = timelineNotePlacement(run({ description: 'Review frontend diff' }), {
      x: 700,
      w: 260,
    })
    expect(note?.anchor).toBe('end')
    expect(note?.x).toBe(694)
    expect(note?.inside).toBe(false)
    // The invariant: the text's own left edge clears the plot's left edge.
    expect((note?.x ?? 0) - (note?.text.length ?? 0) * 6.4).toBeGreaterThanOrEqual(TIMELINE.x0)
  })

  it('never renders left of the plot — the cb07c5ba overprint', () => {
    // The geometry that printed `4.6h · Prototype clip extractor` starting at
    // x = -21, over the row label and off the card's own left edge: a bar that
    // starts at the plot's left edge and runs almost to its right one, so
    // neither outside slot can hold the note.
    const t = run({ start: at(0), end: at(276), description: 'Prototype clip extractor' })
    const note = timelineNotePlacement(t, { x: 176, w: 795 })
    expect(note).not.toBeNull()
    expect(note?.x).toBeGreaterThanOrEqual(TIMELINE.x0)
    expect(note?.anchor).toBe('start')
    // Nowhere beside the bar, so it goes over it, whole.
    expect(note?.inside).toBe(true)
    expect(note?.text).toBe('4.6h · Prototype clip extractor')
  })

  it('never enters the label gutter — the 371e1870 overprint', () => {
    // `32m · Implement script-run backend` on a bar filling most of the plot.
    const t = run({ start: at(0), end: at(32), description: 'Implement script-run backend' })
    const note = timelineNotePlacement(t, { x: 354, w: 484 })
    expect(note?.x).toBeGreaterThanOrEqual(TIMELINE.x0)
    expect(note?.inside).toBe(true)
    expect(note?.x).toBe(360)
  })

  it('truncates the description rather than overflowing the slot it picked', () => {
    const t = run({ start: at(0), end: at(2), description: 'x'.repeat(200) })
    const note = timelineNotePlacement(t, { x: 300, w: 120 })
    expect(note?.text.startsWith('2m · ')).toBe(true)
    expect(note?.text.endsWith('…')).toBe(true)
    // It fits the widest slot it could reach (here the 560-unit right side).
    expect((note?.text.length ?? 0) * 6.4).toBeLessThanOrEqual(TIMELINE.x1 - (300 + 120 + 6))
  })

  it('places an instant pinned to the right edge before its bar, inside the plot', () => {
    const t = run({ start: at(0), end: at(276), description: 'Prototype clip extractor' })
    const note = timelineNotePlacement(t, { x: 978, w: 2 })
    expect(note).toEqual({
      x: 972,
      anchor: 'end',
      text: '4.6h · Prototype clip extractor',
      inside: false,
    })
    expect(972 - '4.6h · Prototype clip extractor'.length * 6.4).toBeGreaterThanOrEqual(
      TIMELINE.x0,
    )
  })

  it('holds the invariant for every bar geometry, not just the reported two', () => {
    // The whole point of the function: sweep the plot and assert that no note
    // ever starts left of x0 (the label gutter) or ends right of x1.
    const t = run({ start: at(0), end: at(37), description: 'Implement script-run backend' })
    for (let w = 2; w <= 808; w += 13) {
      for (const frac of [0, 0.5, 1]) {
        const bar = { x: TIMELINE.x0 + (810 - w) * frac, w }
        const note = timelineNotePlacement(t, bar)
        expect(note).not.toBeNull()
        const width = (note?.text.length ?? 0) * 6.4
        const left = note?.anchor === 'start' ? (note?.x ?? 0) : (note?.x ?? 0) - width
        const right = note?.anchor === 'start' ? (note?.x ?? 0) + width : (note?.x ?? 0)
        expect(left).toBeGreaterThanOrEqual(TIMELINE.x0)
        expect(right).toBeLessThanOrEqual(TIMELINE.x1)
      }
    }
  })

  it('is the duration alone when the run carries no description', () => {
    expect(timelineNotePlacement(run({ start: at(0), end: at(3) }), { x: 200, w: 40 })?.text).toBe(
      '3m',
    )
  })
})

describe('largestWaitingGap', () => {
  const span = { from: Date.parse(at(0)), to: Date.parse(at(100)) }
  it('picks the widest un-painted stretch, not the first one', () => {
    const t = thread({
      start: at(0),
      end: at(100),
      active: [
        { start: at(0), end: at(10) },
        { start: at(20), end: at(30) },
        { start: at(90), end: at(100) },
      ],
    })
    const gap = largestWaitingGap(t, span)
    // The 30→90 gap, six tenths of the 810-unit plot.
    expect(gap?.w).toBeCloseTo(486)
    expect(gap?.x).toBeCloseTo(413)
  })
  it('is null when the active stretches cover the bar — no subagents', () => {
    const t = thread({ start: at(0), end: at(100), active: [{ start: at(0), end: at(100) }] })
    expect(largestWaitingGap(t, span)).toBeNull()
  })
  it('is null for a thread with no bar at all', () => {
    expect(largestWaitingGap(thread(), span)).toBeNull()
  })
})

describe('waitingLabelPlacement', () => {
  const span = { from: Date.parse(at(0)), to: Date.parse(at(100)) }
  it('centres the label in the widest gap, in the hint’s own units', () => {
    const t = thread({
      start: at(0),
      end: at(100),
      active: [
        { start: at(0), end: at(4) },
        { start: at(96), end: at(100) },
      ],
    })
    const label = waitingLabelPlacement(t, span)
    // `fmtDuration`, not a bare minute count — the hint says `1.5h` too.
    expect(label?.text).toBe('waiting on subagents, 1.5h')
    expect(label?.x).toBeCloseTo(575)
  })

  it('is omitted rather than printed over the active bars — the reported bug', () => {
    // Two solid stretches with a 20-unit gap between them. The label needs
    // ~166 units, so the old midpoint placement printed it across both rects.
    const t = thread({
      start: at(0),
      end: at(100),
      active: [
        { start: at(0), end: at(48) },
        { start: at(51), end: at(100) },
      ],
    })
    expect(largestWaitingGap(t, span)?.w).toBeLessThan(30)
    expect(waitingLabelPlacement(t, span)).toBeNull()
  })

  it('is omitted when the thread barely waited at all', () => {
    const t = thread({
      start: at(0),
      end: at(100),
      active: [
        { start: at(0), end: at(50) },
        { start: at(50, 30), end: at(100) },
      ],
    })
    expect(waitingLabelPlacement(t, span)).toBeNull()
  })
})

describe('timelineLegend', () => {
  it('is one swatch per model present, in row order, deduped', () => {
    const rows = [
      thread({ model: 'claude-opus-5' }),
      thread({ model: 'claude-sonnet-5' }),
      thread({ model: 'claude-opus-5' }),
      thread({ model: null }),
    ]
    expect(timelineLegend(rows).map((l) => l.label)).toEqual(['opus-5', 'sonnet-5'])
  })
})

describe('timelineHint', () => {
  it('names the thread count, the span and main’s two halves', () => {
    const main = thread({
      start: at(0),
      end: at(53),
      active: [
        { start: at(0), end: at(4) },
        { start: at(49), end: at(53) },
      ],
    })
    expect(timelineHint([main, thread(), thread()], 53)).toBe(
      '3 threads over 53m. Main was active for 8m and waited 45m on its subagents.',
    )
  })
  it('says so plainly when main never waited', () => {
    const main = thread({ start: at(0), end: at(10), active: [{ start: at(0), end: at(10) }] })
    expect(timelineHint([main], 10)).toBe('1 thread over 10m. Main was working throughout.')
  })
})

describe('timelineHeight', () => {
  it('grows a row at a time and never collapses to nothing', () => {
    expect(timelineHeight(2) - timelineHeight(1)).toBe(TIMELINE.rowH)
    expect(timelineHeight(0)).toBe(timelineHeight(1))
  })
})
