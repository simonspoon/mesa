import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FORM_PX,
  MIN_FORM_PX,
  MIN_LOG_PX,
  activeRun,
  clampFormHeight,
  commandLine,
  finishNdjson,
  formatClock,
  formatDuration,
  formatElapsed,
  formatRunLabel,
  isAtBottom,
  logLinesFrom,
  logText,
  parseEvent,
  runElapsedMs,
  runStartedMs,
  runState,
  runsForScript,
  splitNdjson,
} from './scriptRun'
import type { ScriptRunRecord } from './types/ScriptRunRecord'

function record(extra: Partial<ScriptRunRecord> = {}): ScriptRunRecord {
  return {
    id: 7,
    script_id: 1,
    values: {},
    status: 'finished',
    exit_code: 0,
    note: null,
    truncated: false,
    cwd: '/tmp',
    // A mesa timestamp: UTC, no `T`, no zone marker (see `time.ts`).
    started_at: '2026-09-16 18:20:01',
    ended_at: '2026-09-16 18:20:03',
    ...extra,
  }
}

/** The epoch ms a mesa timestamp means — UTC, which is the whole point. */
const at = (ts: string) => Date.parse(`${ts.replace(' ', 'T')}Z`)

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

describe('runState', () => {
  it('is idle with no run open, which no row can say', () => {
    expect(runState(null)).toBe('idle')
  })

  it('passes the server status through', () => {
    expect(runState(record({ status: 'running', exit_code: null }))).toBe('running')
    expect(runState(record({ status: 'finished', exit_code: 0 }))).toBe('finished')
    // A nonzero exit is data, not a failure: still `finished`.
    expect(runState(record({ status: 'finished', exit_code: 2 }))).toBe('finished')
    expect(runState(record({ status: 'stopped', exit_code: null }))).toBe('stopped')
    expect(runState(record({ status: 'failed', exit_code: null }))).toBe('failed')
  })

  it('reads a finished row with no exit code as failed', () => {
    // `finished` is the pane's word for "an exit status was collected", and
    // every caller printing `exit {code}` depends on that pairing.
    expect(runState(record({ status: 'finished', exit_code: null }))).toBe('failed')
  })
})

describe('logLinesFrom', () => {
  it('keeps the line events in order and drops the terminal ones', () => {
    expect(
      logLinesFrom([
        { type: 'line', stream: 'stdout', t: 0, text: 'one' },
        { type: 'line', stream: 'stderr', t: 5, text: 'two' },
        { type: 'exit', code: 0, duration_ms: 9, truncated: false },
      ]),
    ).toEqual([
      { stream: 'stdout', t: 0, text: 'one' },
      { stream: 'stderr', t: 5, text: 'two' },
    ])
    expect(logLinesFrom([{ type: 'error', message: 'gone' }])).toEqual([])
  })
})

describe('runStartedMs', () => {
  it('reads a mesa timestamp as UTC, not as local time', () => {
    expect(runStartedMs(record())).toBe(at('2026-09-16 18:20:01'))
  })

  it('is null for a stamp that will not parse', () => {
    expect(runStartedMs(record({ started_at: 'not a time' }))).toBeNull()
  })
})

describe('runElapsedMs', () => {
  it('measures a finished run between its own stamps, ignoring now', () => {
    expect(runElapsedMs(record(), at('2026-09-16 19:00:00'))).toBe(2000)
  })

  it('measures a running run from started_at to now, not from a mount', () => {
    const run = record({ status: 'running', exit_code: null, ended_at: null })
    expect(runElapsedMs(run, at('2026-09-16 18:30:01'))).toBe(600_000)
  })

  it('never counts backwards on a skewed clock', () => {
    const run = record({ status: 'running', exit_code: null, ended_at: null })
    expect(runElapsedMs(run, at('2026-09-16 18:00:00'))).toBe(0)
  })

  it('is null for an unparsable start', () => {
    expect(runElapsedMs(record({ started_at: 'x' }), Date.now())).toBeNull()
  })
})

describe('activeRun', () => {
  it('picks the newest running run of that script', () => {
    const runs = [
      record({ id: 3, script_id: 1, status: 'running', exit_code: null }),
      record({ id: 9, script_id: 2, status: 'running', exit_code: null }),
      record({ id: 5, script_id: 1, status: 'running', exit_code: null }),
      record({ id: 8, script_id: 1, status: 'finished' }),
    ]
    expect(activeRun(runs, 1)?.id).toBe(5)
    expect(activeRun(runs, 2)?.id).toBe(9)
  })

  it('is null when nothing of that script is running', () => {
    expect(activeRun([record({ id: 1, status: 'stopped', exit_code: null })], 1)).toBeNull()
    expect(activeRun([], 1)).toBeNull()
  })
})

describe('runsForScript', () => {
  it('takes that script\'s runs newest first, whatever order they arrived in', () => {
    const runs = [
      record({ id: 2, script_id: 1 }),
      record({ id: 7, script_id: 2 }),
      record({ id: 6, script_id: 1 }),
      record({ id: 4, script_id: 1 }),
    ]
    expect(runsForScript(runs, 1, 2).map((r) => r.id)).toEqual([6, 4])
    expect(runsForScript(runs, 1, 99).map((r) => r.id)).toEqual([6, 4, 2])
    expect(runsForScript(runs, 3, 5)).toEqual([])
  })
})

describe('formatRunLabel', () => {
  it('names a finished run by its exit code and how long it took', () => {
    expect(formatRunLabel(record(), at('2026-09-16 19:00:00'))).toBe(
      `${formatClock(at('2026-09-16 18:20:01'))} · exit 0 · 2.0s`,
    )
  })

  it('shows a nonzero exit as the code it is', () => {
    expect(formatRunLabel(record({ exit_code: 2 }), 0)).toContain('· exit 2 ·')
  })

  it('runs a live clock from the server start, not from the page', () => {
    const run = record({ status: 'running', exit_code: null, ended_at: null })
    expect(formatRunLabel(run, at('2026-09-16 18:21:13'))).toBe(
      `${formatClock(at('2026-09-16 18:20:01'))} · running · 01:12`,
    )
  })

  it('names the other two states by their word', () => {
    expect(formatRunLabel(record({ status: 'stopped', exit_code: null }), 0)).toContain(
      '· stopped ·',
    )
    expect(formatRunLabel(record({ status: 'failed', exit_code: null }), 0)).toContain(
      '· failed ·',
    )
  })

  it('still identifies a row whose stamps will not parse', () => {
    expect(formatRunLabel(record({ id: 12, started_at: 'x' }), 0)).toBe('run 12 · exit 0')
  })
})
