import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FORM_PX,
  MIN_FORM_PX,
  MIN_LOG_PX,
  clampFormHeight,
  commandLine,
  finishNdjson,
  formatClock,
  formatDuration,
  formatElapsed,
  isAtBottom,
  logText,
  parseEvent,
  splitNdjson,
} from './scriptRun'

describe('splitNdjson', () => {
  it('keeps a line cut across chunks until its newline arrives', () => {
    const a = splitNdjson('', '{"type":"line","te')
    expect(a).toEqual({ lines: [], rest: '{"type":"line","te' })
    const b = splitNdjson(a.rest, 'xt":"x"}\n{"type":"exit"}\n{"ty')
    expect(b.lines).toEqual(['{"type":"line","text":"x"}', '{"type":"exit"}'])
    expect(b.rest).toBe('{"ty')
  })

  it('drops blank lines and flushes an unterminated tail at the end', () => {
    expect(splitNdjson('', '\n\n{"a":1}\n').lines).toEqual(['{"a":1}'])
    expect(finishNdjson('{"type":"exit"}')).toEqual(['{"type":"exit"}'])
    expect(finishNdjson('  ')).toEqual([])
  })
})

describe('parseEvent', () => {
  it('accepts the three event types and nothing else', () => {
    expect(parseEvent('{"type":"line","stream":"stderr","t":5,"text":"x"}')).toEqual({
      type: 'line',
      stream: 'stderr',
      t: 5,
      text: 'x',
    })
    expect(parseEvent('{"type":"exit","code":0,"duration_ms":1,"truncated":false}')?.type).toBe(
      'exit',
    )
    expect(parseEvent('{"type":"error","message":"m"}')?.type).toBe('error')
    expect(parseEvent('{"type":"other"}')).toBeNull()
    expect(parseEvent('null')).toBeNull()
    expect(parseEvent('{not json')).toBeNull()
  })
})

describe('isAtBottom', () => {
  it('is true at the end and within the slack, false once scrolled up', () => {
    expect(isAtBottom(900, 100, 1000)).toBe(true)
    expect(isAtBottom(893.5, 100, 1000)).toBe(true)
    expect(isAtBottom(850, 100, 1000)).toBe(false)
    // Content shorter than the box is always at the bottom.
    expect(isAtBottom(0, 400, 200)).toBe(true)
  })
})

describe('clampFormHeight', () => {
  it('keeps the form above its floor and the log above its own', () => {
    expect(clampFormHeight(300, 800)).toBe(300)
    expect(clampFormHeight(10, 800)).toBe(MIN_FORM_PX)
    expect(clampFormHeight(790, 800)).toBe(800 - MIN_LOG_PX)
  })

  it('never answers a max below the min, and defaults a non-finite drag', () => {
    expect(clampFormHeight(500, 150)).toBe(MIN_FORM_PX)
    expect(clampFormHeight(Number.NaN, 800)).toBe(DEFAULT_FORM_PX)
  })
})

describe('time formatting', () => {
  it('formats a running clock', () => {
    expect(formatElapsed(0)).toBe('00:00')
    expect(formatElapsed(41_900)).toBe('00:41')
    expect(formatElapsed(3_725_000)).toBe('1:02:05')
    expect(formatElapsed(-5)).toBe('00:00')
  })

  it('formats a finished duration', () => {
    expect(formatDuration(812)).toBe('0.8s')
    expect(formatDuration(59_940)).toBe('59.9s')
    expect(formatDuration(245_000)).toBe('4m 05s')
  })

  it('formats a local wall clock', () => {
    const at = new Date(2026, 8, 16, 18, 20, 1).getTime()
    expect(formatClock(at)).toBe('18:20:01')
  })
})

describe('commandLine', () => {
  it('renders the equivalent CLI call, quoting anything not a plain word', () => {
    expect(commandLine('release', { version: '0.30.0', dry_run: 'true' })).toBe(
      'release --set version=0.30.0 --set dry_run=true',
    )
    expect(commandLine('greet', { who: "it's me" })).toBe(`greet --set 'who=it'\\''s me'`)
    expect(commandLine('bare', {})).toBe('bare')
  })
})

describe('logText', () => {
  it('timestamps every line and tags stderr', () => {
    const start = new Date(2026, 8, 16, 18, 20, 1).getTime()
    expect(
      logText(
        [
          { stream: 'stdout', t: 0, text: 'one' },
          { stream: 'stderr', t: 2000, text: 'two' },
        ],
        start,
      ),
    ).toBe('18:20:01 one\n18:20:03 stderr two')
  })
})
