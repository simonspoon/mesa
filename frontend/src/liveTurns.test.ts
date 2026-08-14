import { describe, expect, it } from 'vitest'
import {
  advanceCursor,
  mergeTurns,
  navigateTarget,
  nextUnplayed,
  spokenText,
  turnGroups,
  turnLabel,
} from './liveTurns'
import type { LiveTurn } from './types/LiveTurn'

function turn(id: number, patch: Partial<LiveTurn> = {}): LiveTurn {
  return {
    id,
    session_id: 1,
    role: 'mesa',
    text: 'the board is open',
    action: null,
    target: null,
    created_at: '2026-01-01 00:00:00',
    delivered_at: null,
    played_at: null,
    ...patch,
  }
}

describe('advanceCursor', () => {
  it('is the highest id the page has seen', () => {
    expect(advanceCursor(null, [turn(4), turn(7)])).toBe(7)
    expect(advanceCursor(7, [turn(9)])).toBe(9)
  })

  it('never goes backwards', () => {
    // A page that arrived out of order, or a refetch of older turns, must not
    // re-deliver everything after it on the next poll.
    expect(advanceCursor(9, [turn(4)])).toBe(9)
  })

  it('leaves an empty page exactly where it was', () => {
    expect(advanceCursor(9, [])).toBe(9)
    expect(advanceCursor(null, [])).toBeNull()
  })
})

describe('mergeTurns', () => {
  it('accumulates the transcript across pages, ascending', () => {
    expect(mergeTurns([turn(1), turn(2)], [turn(3)]).map((t) => t.id)).toEqual([
      1, 2, 3,
    ])
  })

  it('keeps one row per id, preferring the later copy', () => {
    const merged = mergeTurns(
      [turn(1), turn(2)],
      [turn(2, { played_at: '2026-01-01 00:00:05' })],
    )
    expect(merged.map((t) => t.id)).toEqual([1, 2])
    expect(merged[1].played_at).toBe('2026-01-01 00:00:05')
  })

  it('sorts a page that arrived out of order', () => {
    expect(mergeTurns([], [turn(9), turn(4)]).map((t) => t.id)).toEqual([4, 9])
  })

  it('does not disturb what it was given', () => {
    const held = [turn(2), turn(1)]
    mergeTurns(held, [turn(3)])
    expect(held.map((t) => t.id)).toEqual([2, 1])
  })
})

describe('nextUnplayed', () => {
  it('takes the oldest mesa turn nobody has played', () => {
    const next = nextUnplayed([turn(4), turn(7)], new Set())
    expect(next?.id).toBe(4)
  })

  it('never speaks the user back to themselves', () => {
    expect(nextUnplayed([turn(4, { role: 'user' })], new Set())).toBeNull()
  })

  it('skips what the server has already stamped', () => {
    const next = nextUnplayed(
      [turn(4, { played_at: '2026-01-01 00:00:05' }), turn(7)],
      new Set(),
    )
    expect(next?.id).toBe(7)
  })

  it('skips what this page has already taken in hand', () => {
    // The stamp only lands on the next poll; without this every poll in that
    // window would start the same turn again.
    const next = nextUnplayed([turn(4), turn(7)], new Set([4]))
    expect(next?.id).toBe(7)
  })

  it('is null when there is nothing left to say', () => {
    expect(nextUnplayed([], new Set())).toBeNull()
    expect(nextUnplayed([turn(4)], new Set([4]))).toBeNull()
  })
})

describe('spokenText', () => {
  it('is the turn’s text, trimmed', () => {
    expect(spokenText(turn(1, { text: '  the board is open  ' }))).toBe(
      'the board is open',
    )
  })

  it('is null for a pure navigate turn', () => {
    // It moves the page and says nothing; an empty body is not something the
    // synthesiser can be asked for.
    expect(
      spokenText(turn(1, { text: '', action: 'navigate', target: '#/inbox' })),
    ).toBeNull()
    expect(spokenText(turn(1, { text: '   ' }))).toBeNull()
  })

  it('is null for a user turn', () => {
    expect(spokenText(turn(1, { role: 'user', text: 'open the board' }))).toBeNull()
  })
})

describe('navigateTarget', () => {
  it('is the route a navigate turn carries', () => {
    expect(
      navigateTarget(turn(1, { action: 'navigate', target: '#/projects/3' })),
    ).toBe('#/projects/3')
  })

  it('is null when the turn only speaks', () => {
    expect(navigateTarget(turn(1))).toBeNull()
    expect(navigateTarget(turn(1, { target: '#/inbox' }))).toBeNull()
  })

  it('refuses anything that is not a hash route', () => {
    // This value is written straight into `location.hash`, so the page is the
    // last place it can be checked.
    expect(navigateTarget(turn(1, { action: 'navigate', target: null }))).toBeNull()
    expect(
      navigateTarget(turn(1, { action: 'navigate', target: 'https://elsewhere' })),
    ).toBeNull()
    expect(navigateTarget(turn(1, { action: 'navigate', target: '  ' }))).toBeNull()
  })
})

describe('turnGroups', () => {
  it('runs consecutive turns by one side together', () => {
    const groups = turnGroups([
      turn(1, { role: 'user' }),
      turn(2),
      turn(3),
      turn(4, { role: 'user' }),
    ])
    expect(groups.map((g) => [g.role, g.turns.map((t) => t.id)])).toEqual([
      ['user', [1]],
      ['mesa', [2, 3]],
      ['user', [4]],
    ])
  })

  it('is empty for an empty transcript', () => {
    expect(turnGroups([])).toEqual([])
  })
})

describe('turnLabel', () => {
  it('names each side the way the agent chat does', () => {
    expect(turnLabel('user')).toBe('you')
    expect(turnLabel('mesa')).toBe('mesa')
  })
})
