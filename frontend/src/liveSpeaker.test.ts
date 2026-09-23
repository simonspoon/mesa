import { beforeEach, describe, expect, it } from 'vitest'
import {
  liveClientId,
  MAX_LIVE_CLIENT_ID,
  maySpeak,
  spokenTurnVerdict,
  takesToSpeak,
} from './liveSpeaker'
import { pendingTurns } from './liveTurns'
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

describe('maySpeak', () => {
  it('lets only the speaker speak when two unlocked clients are in the room', () => {
    expect(maySpeak('tab-a', 'tab-a')).toBe(true)
    expect(maySpeak('tab-a', 'tab-b')).toBe(false)
  })

  it('lets every unlocked client speak while nobody has claimed it', () => {
    // The behaviour mesa had before the claim existed, kept deliberately: a
    // client that knows nothing of this rule is never silenced by it.
    expect(maySpeak(null, 'tab-a')).toBe(true)
    expect(maySpeak(null, 'tab-b')).toBe(true)
  })

  it('reads a stale claim as free, the server having already nulled it', () => {
    // Staleness is the server's arithmetic on its own clock: a claim nobody
    // refreshed comes back as `null`, which is the case above. The page never
    // subtracts two timestamps, so a closed tab cannot leave it mute.
    const stale = null
    expect(maySpeak(stale, 'tab-b')).toBe(true)
  })

  it('moves with the press: the new speaker speaks and the old one stops', () => {
    // One poll's session before and after someone pressed Listen on tab-b.
    const before = 'tab-a'
    const after = 'tab-b'
    expect(maySpeak(before, 'tab-a')).toBe(true)
    expect(maySpeak(before, 'tab-b')).toBe(false)
    expect(maySpeak(after, 'tab-a')).toBe(false)
    expect(maySpeak(after, 'tab-b')).toBe(true)
  })
})

describe('liveClientId', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('generates one id and keeps answering with it', () => {
    const first = liveClientId()
    expect(first).not.toBe('')
    expect(first.length).toBeLessThanOrEqual(MAX_LIVE_CLIENT_ID)
    expect(liveClientId()).toBe(first)
  })

  it('answers a stored id, so a reload keeps the same seat in the conversation', () => {
    localStorage.setItem('mesa-live-client', '  tab-a  ')
    expect(liveClientId()).toBe('tab-a')
  })

  it('replaces a stored value the server would refuse', () => {
    for (const bad of ['', '   ', 'x'.repeat(MAX_LIVE_CLIENT_ID + 1)]) {
      localStorage.setItem('mesa-live-client', bad)
      const id = liveClientId()
      expect(id.trim()).toBe(id)
      expect(id).not.toBe('')
      expect(id.length).toBeLessThanOrEqual(MAX_LIVE_CLIENT_ID)
    }
  })
})

describe('takesToSpeak', () => {
  it('lets only the speaker take a turn in hand to say it', () => {
    expect(takesToSpeak(turn(5), 'tab-a', 'tab-a')).toBe(true)
    expect(takesToSpeak(turn(5), 'tab-a', 'tab-b')).toBe(false)
    expect(takesToSpeak(turn(5), null, 'tab-b')).toBe(true)
  })

  it('is false for a turn that says nothing, whoever holds the voice', () => {
    // A pure action turn is performed and stamped by every browser that
    // reaches it; it never enters the speech path at all.
    const silent = turn(5, { text: '', action: 'navigate', target: '#/inbox' })
    expect(takesToSpeak(silent, 'tab-a', 'tab-a')).toBe(false)
    expect(takesToSpeak(silent, null, 'tab-a')).toBe(false)
  })

  it('skipping a turn consumes nothing, so a freed page can still say it', () => {
    // The failure this rule exists to stop. A speaks, B is a second tab left
    // open. Turn 5 arrives; B may not say it, so B takes it in hand for
    // NOTHING. A's browser is then killed mid-sentence: nothing ever stamps
    // `played_at`, A's claim goes stale, and the poll hands B a null speaker.
    // Turn 5 has to still be there for B, or the conversation is silent — the
    // very failure the stale-claim rule exists to prevent.
    const turns = [turn(5)]
    const handled = new Set<number>()
    const take = (speaker: string | null) => {
      const took: number[] = []
      for (const t of pendingTurns(turns, handled)) {
        if (!takesToSpeak(t, speaker, 'tab-b')) continue
        handled.add(t.id)
        took.push(t.id)
      }
      return took
    }
    expect(take('tab-a')).toEqual([])
    expect(pendingTurns(turns, handled).map((t) => t.id)).toEqual([5])
    expect(take(null)).toEqual([5])
    // …and having said it, B does not say it again on the next poll.
    expect(take(null)).toEqual([])
  })
})

describe('spokenTurnVerdict', () => {
  it('speaks a turn this page holds the voice for, unless speech is muted', () => {
    expect(spokenTurnVerdict(turn(5), 'tab-a', 'tab-a', false)).toBe('speak')
    expect(spokenTurnVerdict(turn(5), null, 'tab-a', false)).toBe('speak')
    // Muted: the turn is read rather than said — taken in hand and stamped,
    // so unmuting does not replay it.
    expect(spokenTurnVerdict(turn(5), 'tab-a', 'tab-a', true)).toBe('read')
    expect(spokenTurnVerdict(turn(5), null, 'tab-a', true)).toBe('read')
  })

  it('leaves a turn another browser speaks, muted or not', () => {
    // A muted page never consumes a turn it could not have said anyway: the
    // speaker still says it, and a freed page can still pick it up.
    expect(spokenTurnVerdict(turn(5), 'tab-a', 'tab-b', false)).toBe('leave')
    expect(spokenTurnVerdict(turn(5), 'tab-a', 'tab-b', true)).toBe('leave')
  })

  it('leaves a turn that says nothing, which the action path stamps itself', () => {
    const silent = turn(5, { text: '', action: 'navigate', target: '#/inbox' })
    expect(spokenTurnVerdict(silent, 'tab-a', 'tab-a', true)).toBe('leave')
  })
})
