import { describe, expect, it } from 'vitest'
import { formatTimestamp, parseTimestamp, timeAgo } from './time'

// SQLite `datetime('now')`: UTC, space-separated, no zone marker.
const TS = '2026-07-26 05:30:32'
const INSTANT = Date.UTC(2026, 6, 26, 5, 30, 32)

describe('parseTimestamp', () => {
  it('reads a zoneless mesa timestamp as UTC, not local', () => {
    // The whole point of the module: `new Date(TS)` reads the bare form as
    // local time, so under any non-UTC zone this assert is what fails.
    expect(parseTimestamp(TS).getTime()).toBe(INSTANT)
  })
})

describe('formatTimestamp', () => {
  it('renders the UTC instant in the viewer’s locale', () => {
    // toLocaleString on both sides cancels the zone out, leaving the claim
    // under test — that the *instant* was parsed as UTC.
    expect(formatTimestamp(TS)).toBe(new Date(INSTANT).toLocaleString())
  })
})

describe('timeAgo', () => {
  const ago = (secs: number) => timeAgo(TS, INSTANT + secs * 1000)

  it.each([
    [0, 'just now'],
    [59, 'just now'],
    [60, '1m ago'],
    [119, '1m ago'], // floors rather than rounds
    [59 * 60, '59m ago'],
    [60 * 60, '1h ago'],
    [23 * 3600, '23h ago'],
    [24 * 3600, '1d ago'],
    [10 * 86400, '10d ago'],
  ])('renders %i seconds as "%s"', (secs, expected) => {
    expect(ago(secs)).toBe(expected)
  })

  it('never prints a negative age for a clock-skewed future stamp', () => {
    expect(ago(-3600)).toBe('just now')
  })
})
