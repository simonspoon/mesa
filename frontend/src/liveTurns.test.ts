import { describe, expect, it } from 'vitest'
import {
  actsOn,
  advanceCursor,
  isNaruRole,
  mergeTurns,
  navigateTarget,
  nextUnplayed,
  pendingTurns,
  releaseForReplay,
  sidebarsIntent,
  spokenText,
  transcriptFor,
  turnGroups,
  turnLabel,
} from './liveTurns'
import type { LiveTurn } from './types/LiveTurn'

function turn(id: number, patch: Partial<LiveTurn> = {}): LiveTurn {
  return {
    id,
    session_id: 1,
    role: 'naru',
    text: 'the board is open',
    action: null,
    target: null,
    notice: null,
    agent_id: null,
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

describe('transcriptFor', () => {
  it('accumulates while the poll stays on the same conversation', () => {
    const { turns, fresh } = transcriptFor([turn(1), turn(2)], 5, 5, [turn(3)])
    expect(turns.map((t) => t.id)).toEqual([1, 2, 3])
    expect(fresh).toBe(false)
  })

  it('drops the old conversation when the session ends (mesa task 862)', () => {
    // What End looks like on the wire: no session, no turns. Keeping the turns
    // held here is the replay — every one of them still says `played_at: null`,
    // because the cursor means the server never sends those rows again.
    const { turns, fresh } = transcriptFor([turn(1), turn(2)], 5, null, [])
    expect(turns).toEqual([])
    expect(fresh).toBe(true)
  })

  it('starts the next conversation empty', () => {
    const { turns, fresh } = transcriptFor([turn(1)], 5, 6, [turn(7)])
    expect(turns.map((t) => t.id)).toEqual([7])
    expect(fresh).toBe(true)
  })

  it('is not fresh while there has never been a session', () => {
    // The idle page polls `{session: null, turns: []}` for as long as nobody
    // presses Go live; each of those must not read as a new conversation.
    expect(transcriptFor([], null, null, []).fresh).toBe(false)
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

describe('releaseForReplay', () => {
  it('hands the turn a pause cut off back to the run', () => {
    // Taken in hand before it sounded, never stamped: without the release
    // Resume would skip it and the sentence would be lost.
    const handled = new Set([4])
    releaseForReplay(handled, 4)
    expect(nextUnplayed([turn(4), turn(7)], handled)?.id).toBe(4)
  })

  it('releases nothing when nothing was sounding', () => {
    const handled = new Set([4])
    releaseForReplay(handled, null)
    expect(handled).toEqual(new Set([4]))
  })

  it('is a no-op for an id the page never took in hand', () => {
    const handled = new Set([4])
    releaseForReplay(handled, 9)
    expect(handled).toEqual(new Set([4]))
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

  it('is null for a sidebar turn', () => {
    // The two vocabularies must not read each other's turns: a collapse is not
    // a navigation with a missing route.
    expect(navigateTarget(turn(1, { action: 'collapse-sidebars' }))).toBeNull()
  })
})

describe('sidebarsIntent', () => {
  it('reads the verb the turn carries', () => {
    expect(sidebarsIntent(turn(1, { action: 'collapse-sidebars' }))).toBe('collapse')
    expect(sidebarsIntent(turn(1, { action: 'expand-sidebars' }))).toBe('expand')
  })

  it('is null for a turn that leaves the sidebars alone', () => {
    expect(sidebarsIntent(turn(1))).toBeNull()
    expect(
      sidebarsIntent(turn(1, { action: 'navigate', target: '#/inbox' })),
    ).toBeNull()
  })

  it('speaks whatever text a sidebar turn carries, and nothing when it has none', () => {
    // The pure-action rule, unchanged: a sidebar verb may narrate itself or
    // move the panels in silence.
    expect(
      spokenText(turn(1, { text: 'Making some room.', action: 'collapse-sidebars' })),
    ).toBe('Making some room.')
    expect(spokenText(turn(1, { text: '', action: 'expand-sidebars' }))).toBeNull()
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
      ['naru', [2, 3]],
      ['user', [4]],
    ])
    expect(groups.every((g) => !g.notice)).toBe(true)
  })

  it('keeps a notice out of the agent’s run on either side of it', () => {
    // mesa's own report about the agent (mesa task 1157) is labelled apart,
    // so it is grouped apart — even between two turns the agent said.
    const groups = turnGroups([
      turn(1),
      turn(2, { notice: 'permission' }),
      turn(3),
      turn(4, { notice: 'permission' }),
      turn(5, { notice: 'permission' }),
    ])
    expect(groups.map((g) => [g.notice, g.turns.map((t) => t.id)])).toEqual([
      [false, [1]],
      [true, [2]],
      [false, [3]],
      [true, [4, 5]],
    ])
  })

  it('is empty for an empty transcript', () => {
    expect(turnGroups([])).toEqual([])
  })
})

describe('turnLabel', () => {
  it('names each side the way the agent chat does', () => {
    expect(turnLabel('user')).toBe('you')
    expect(turnLabel('naru')).toBe('Naru')
  })

  it('names a notice as one, not as mesa', () => {
    expect(turnLabel('naru', true)).toBe('notice')
    expect(turnLabel('naru', false)).toBe('Naru')
  })
})

describe('pendingTurns', () => {
  it('is every mesa turn nobody has played and this page has not taken in hand', () => {
    const turns = [
      turn(1, { role: 'user', text: 'what is on the board' }),
      turn(2, { played_at: '2026-01-01 00:00:01' }),
      turn(3),
      turn(4),
    ]
    expect(pendingTurns(turns, new Set([3])).map((t) => t.id)).toEqual([4])
    expect(pendingTurns(turns, new Set()).map((t) => t.id)).toEqual([3, 4])
  })

  it('leads with what nextUnplayed answers, so the two can never disagree', () => {
    const turns = [turn(3), turn(4)]
    expect(nextUnplayed(turns, new Set())?.id).toBe(pendingTurns(turns, new Set())[0].id)
    expect(nextUnplayed(turns, new Set([3, 4]))).toBeNull()
  })
})

describe('actsOn', () => {
  const navigates = turn(5, { action: 'navigate', target: '#/inbox' })
  const folds = turn(6, { action: 'collapse-sidebars', text: 'tidying up' })

  it('is true for a turn that does something to the browser, once', () => {
    const performed = new Set<number>()
    expect(actsOn(navigates, performed)).toBe(true)
    performed.add(navigates.id)
    // The later polls, on a page that never spoke it: the action must not
    // fire again (mesa task 1267 — this is why `performed` is its own set).
    expect(actsOn(navigates, performed)).toBe(false)
    expect(actsOn(navigates, performed)).toBe(false)
  })

  it('is true for a sidebar turn that also speaks', () => {
    expect(actsOn(folds, new Set())).toBe(true)
  })

  it('is false for a turn that only speaks', () => {
    expect(actsOn(turn(7), new Set())).toBe(false)
  })
})

describe('a turn stored as mesa before mesa task 1319', () => {
  // The server writes `naru`; a row written before that still reads `mesa`,
  // which the generated type no longer names — hence the one widening cast.
  const legacy = (id: number, patch: Partial<LiveTurn> = {}) =>
    turn(id, { role: 'mesa' as LiveTurn['role'], ...patch })

  it('is Naru’s side, as naru is, and the user is not', () => {
    expect(isNaruRole('mesa')).toBe(true)
    expect(isNaruRole('naru')).toBe(true)
    expect(isNaruRole('user')).toBe(false)
  })

  it('is spoken and queued like a naru turn', () => {
    expect(spokenText(legacy(1))).toBe('the board is open')
    expect(
      pendingTurns([legacy(1), turn(2, { role: 'user' })], new Set()).map((t) => t.id),
    ).toEqual([1])
    expect(nextUnplayed([legacy(3)], new Set())?.id).toBe(3)
  })

  it('runs together with a naru turn beside it', () => {
    const groups = turnGroups([turn(1), legacy(2), turn(3, { role: 'user' })])
    expect(groups.map((g) => g.turns.map((t) => t.id))).toEqual([[1, 2], [3]])
    expect(turnLabel(legacy(2).role)).toBe('Naru')
  })
})
