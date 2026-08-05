import { describe, expect, it } from 'vitest'
import {
  bucketSeries,
  cacheHitRatio,
  fmtDuration,
  tokenSlices,
  tokensPerMinute,
  topTools,
} from './sessionDetail'
import type { CcSessionBucket } from './types/CcSessionBucket'
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
