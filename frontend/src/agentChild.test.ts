import { describe, expect, it } from 'vitest'
import { childElapsed, childLabel, orderedChildren } from './agentChild'
import type { AgentChild } from './types/AgentChild'

function child(over: Partial<AgentChild> = {}): AgentChild {
  return {
    kind: 'subagent',
    name: 'implementer',
    detail: null,
    startedAt: null,
    contextTokens: null,
    state: 'running',
    ...over,
  }
}

describe('childLabel', () => {
  it('leads with the agent type for a subagent and the command for a shell', () => {
    expect(childLabel(child())).toBe('implementer')
    expect(childLabel(child({ kind: 'shell', name: '/bin/zsh -c cargo test' }))).toBe(
      '/bin/zsh -c cargo test',
    )
  })

  it('collapses a multi-line command onto one line', () => {
    expect(childLabel(child({ kind: 'shell', name: 'set -e\n\ncargo   test' }))).toBe(
      'set -e cargo test',
    )
  })

  it('falls back to the kind rather than rendering a blank card', () => {
    expect(childLabel(child({ name: '   ' }))).toBe('subagent')
    expect(childLabel(child({ kind: 'shell', name: '' }))).toBe('shell')
  })
})

describe('childElapsed', () => {
  // The server's own timestamp text: UTC, no `T`, no zone marker.
  const start = '2026-09-21 13:00:00'
  const at = (ms: number) => childElapsed(start, Date.parse('2026-09-21T13:00:00Z') + ms)

  it('counts up in the compact unit a card has room for', () => {
    expect(at(0)).toBe('0s')
    expect(at(7_400)).toBe('7s')
    expect(at(59_999)).toBe('59s')
    expect(at(60_000)).toBe('1m')
    expect(at(59 * 60_000)).toBe('59m')
    expect(at(60 * 60_000)).toBe('1h')
    expect(at(23 * 3_600_000)).toBe('23h')
    expect(at(49 * 3_600_000)).toBe('2d')
  })

  it('never claims more time than has passed, and never goes negative', () => {
    expect(at(119_000)).toBe('1m')
    expect(at(-5_000)).toBe('0s')
  })

  it('says nothing when the server could not say when it started', () => {
    // Not "0s": an absent start time must not read as one that began now.
    expect(childElapsed(null, Date.now())).toBeNull()
    expect(childElapsed('not a timestamp', Date.now())).toBeNull()
  })
})

describe('orderedChildren', () => {
  it('puts running before finished, and subagents before shells within each', () => {
    const rows = [
      child({ name: 'done-sub', state: 'finished' }),
      child({ kind: 'shell', name: 'sh-a' }),
      child({ name: 'sub-a' }),
      child({ kind: 'shell', name: 'sh-b' }),
      child({ name: 'sub-b' }),
    ]
    expect(orderedChildren(rows).map((c) => c.name)).toEqual([
      'sub-a',
      'sub-b',
      'sh-a',
      'sh-b',
      'done-sub',
    ])
  })

  it('is stable within a group, so a card does not hop between polls', () => {
    const rows = [child({ name: 'first' }), child({ name: 'second' }), child({ name: 'third' })]
    expect(orderedChildren(rows).map((c) => c.name)).toEqual(['first', 'second', 'third'])
    expect(orderedChildren([])).toEqual([])
  })

  it('leaves the caller\'s array untouched', () => {
    const rows = [child({ name: 'b', state: 'finished' }), child({ name: 'a' })]
    orderedChildren(rows)
    expect(rows.map((c) => c.name)).toEqual(['b', 'a'])
  })
})
