import { describe, expect, it } from 'vitest'
import {
  STALL_MS,
  initialWatchdog,
  noticeInSpan,
  shouldNoticePermission,
  shouldNoticeStalled,
  watchdogAfterPoll,
  watchdogAfterSpeech,
} from './liveWatchdog'
import type { LiveTurn } from './types/LiveTurn'

function turn(id: number, patch: Partial<LiveTurn> = {}): LiveTurn {
  return {
    id,
    session_id: 1,
    role: 'mesa',
    text: 'one moment',
    action: null,
    target: null,
    notice: null,
    created_at: '2026-01-01 00:00:10',
    delivered_at: null,
    played_at: null,
    ...patch,
  }
}

describe('watchdogAfterPoll', () => {
  it('resets the clock when a working span begins', () => {
    const start = initialWatchdog(1, 1000)
    const idle = watchdogAfterPoll(start, { workingSince: null, turns: [], blocked: null, now: 5000 })
    expect(idle.lastActivityAt).toBe(1000)
    const working = watchdogAfterPoll(idle, {
      workingSince: '2026-01-01 00:00:05',
      turns: [],
      blocked: null,
      now: 6000,
    })
    expect(working.lastActivityAt).toBe(6000)
    // The same span on the next poll is not a new edge.
    const still = watchdogAfterPoll(working, {
      workingSince: '2026-01-01 00:00:05',
      turns: [],
      blocked: null,
      now: 9000,
    })
    expect(still.lastActivityAt).toBe(6000)
    // A later span is.
    const next = watchdogAfterPoll(still, {
      workingSince: '2026-01-01 00:00:09',
      turns: [],
      blocked: null,
      now: 9500,
    })
    expect(next.lastActivityAt).toBe(9500)
  })

  it('resets the clock when a new mesa turn arrives, never on a user turn', () => {
    const start = initialWatchdog(1, 1000)
    const one = watchdogAfterPoll(start, { workingSince: null, turns: [turn(3)], blocked: null, now: 2000 })
    expect(one.lastActivityAt).toBe(2000)
    expect(one.lastTurnId).toBe(3)
    // Seeing the same turn again is not activity.
    const same = watchdogAfterPoll(one, { workingSince: null, turns: [turn(3)], blocked: null, now: 3000 })
    expect(same.lastActivityAt).toBe(2000)
    // The person talking says nothing about the agent.
    const user = watchdogAfterPoll(same, {
      workingSince: null,
      turns: [turn(3), turn(4, { role: 'user' })],
      blocked: null,
      now: 4000,
    })
    expect(user.lastActivityAt).toBe(2000)
    const reply = watchdogAfterPoll(user, {
      workingSince: null,
      turns: [turn(3), turn(4, { role: 'user' }), turn(5)],
      blocked: null,
      now: 5000,
    })
    expect(reply.lastActivityAt).toBe(5000)
  })

  it('a reply that ends a long silence is seen before the stall is judged', () => {
    // The transcript and the session must come from one poll: judged against
    // the previous poll's turns, the reply is not yet seen and the stale
    // clock reports a stall one second after the agent answered.
    const working = watchdogAfterPoll(initialWatchdog(1, 1000), {
      workingSince: '2026-01-01 00:00:05',
      turns: [],
      blocked: null,
      now: 2000,
    })
    const now = 2000 + STALL_MS + 5000
    const stale = { working: true, speaking: false, now, alreadyNoticed: false }
    // The poll carrying the reply: the clock is reset first…
    const replied = watchdogAfterPoll(working, {
      workingSince: '2026-01-01 00:00:05',
      turns: [turn(7)],
      blocked: null,
      now,
    })
    expect(shouldNoticeStalled({ ...stale, lastActivityAt: replied.lastActivityAt })).toBe(false)
    // …whereas the same poll judged against the old transcript would fire.
    const unseen = watchdogAfterPoll(working, {
      workingSince: '2026-01-01 00:00:05',
      turns: [],
      blocked: null,
      now,
    })
    expect(shouldNoticeStalled({ ...stale, lastActivityAt: unseen.lastActivityAt })).toBe(true)
    // A tick that re-runs the same poll changes nothing.
    const ticked = watchdogAfterPoll(replied, {
      workingSince: '2026-01-01 00:00:05',
      turns: [turn(7)],
      blocked: null,
      now: now + 1000,
    })
    expect(ticked.lastActivityAt).toBe(replied.lastActivityAt)
  })

  it('a span ending is remembered but is not activity', () => {
    const working = watchdogAfterPoll(initialWatchdog(1, 1000), {
      workingSince: '2026-01-01 00:00:05',
      turns: [],
      blocked: null,
      now: 2000,
    })
    const ended = watchdogAfterPoll(working, { workingSince: null, turns: [], blocked: null, now: 3000 })
    expect(ended.lastActivityAt).toBe(2000)
    expect(ended.workingSince).toBeNull()
  })
})

describe('watchdogAfterSpeech', () => {
  it('counts the end of playback as activity, so a long reply is never silence', () => {
    const w = initialWatchdog(1, 1000)
    expect(watchdogAfterSpeech(w, 50_000).lastActivityAt).toBe(50_000)
  })
})

describe('noticeInSpan', () => {
  const spanStart = '2026-01-01 00:00:10'
  it('finds a notice of that kind at or after the span start', () => {
    expect(
      noticeInSpan([turn(1, { notice: 'stalled', created_at: spanStart })], 'stalled', spanStart),
    ).toBe(true)
    expect(
      noticeInSpan(
        [turn(1, { notice: 'stalled', created_at: '2026-01-01 00:00:11' })],
        'stalled',
        spanStart,
      ),
    ).toBe(true)
  })

  it('ignores an older span, the other kind, and plain turns', () => {
    expect(
      noticeInSpan(
        [turn(1, { notice: 'stalled', created_at: '2026-01-01 00:00:09' })],
        'stalled',
        spanStart,
      ),
    ).toBe(false)
    expect(
      noticeInSpan([turn(1, { notice: 'permission', created_at: spanStart })], 'stalled', spanStart),
    ).toBe(false)
    expect(noticeInSpan([turn(1, { created_at: spanStart })], 'stalled', spanStart)).toBe(false)
  })
})

describe('shouldNoticeStalled', () => {
  const quiet = { working: true, speaking: false, now: 100_000, lastActivityAt: 0, alreadyNoticed: false }

  it('fires only once the silence reaches STALL_MS while working', () => {
    expect(shouldNoticeStalled(quiet)).toBe(true)
    expect(shouldNoticeStalled({ ...quiet, now: STALL_MS })).toBe(true)
    expect(shouldNoticeStalled({ ...quiet, now: STALL_MS - 1 })).toBe(false)
  })

  it('never fires while not working, while mesa is speaking, or twice in a span', () => {
    expect(shouldNoticeStalled({ ...quiet, working: false })).toBe(false)
    expect(shouldNoticeStalled({ ...quiet, speaking: true })).toBe(false)
    expect(shouldNoticeStalled({ ...quiet, alreadyNoticed: true })).toBe(false)
  })
})

describe('shouldNoticePermission', () => {
  const prompt = 'permission prompt'

  it('fires on the rising edge of a block that has not been reported this span', () => {
    expect(shouldNoticePermission({ blocked: prompt, wasBlocked: null, alreadyNoticed: false })).toBe(
      true,
    )
    expect(shouldNoticePermission({ blocked: prompt, wasBlocked: null, alreadyNoticed: true })).toBe(
      false,
    )
    expect(shouldNoticePermission({ blocked: null, wasBlocked: null, alreadyNoticed: false })).toBe(
      false,
    )
    expect(
      shouldNoticePermission({ blocked: prompt, wasBlocked: prompt, alreadyNoticed: false }),
    ).toBe(false)
  })

  // Drives the clock through a sequence of polls and counts the notices a
  // page following the rule would post, `noticed` standing in for the
  // per-span memory (a span change forgets it, exactly as the page does).
  function noticesOver(polls: { workingSince: string; blocked: string | null }[]): number {
    let w = initialWatchdog(1, 0)
    const noticed = new Set<string>()
    let posted = 0
    polls.forEach((poll, i) => {
      const prev = w
      w = watchdogAfterPoll(prev, { workingSince: poll.workingSince, turns: [], blocked: poll.blocked, now: i })
      const key = `permission@${poll.workingSince}`
      if (
        shouldNoticePermission({ blocked: w.blocked, wasBlocked: prev.blocked, alreadyNoticed: noticed.has(key) })
      ) {
        noticed.add(key)
        posted += 1
      }
    })
    return posted
  }

  it('a block persisting across a span change is reported once', () => {
    // The prompt is answered: `next_user_turn` opens a new span while the
    // server's 5s cache still answers the old block.
    expect(
      noticesOver([
        { workingSince: '2026-01-01 00:00:05', blocked: prompt },
        { workingSince: '2026-01-01 00:00:05', blocked: prompt },
        { workingSince: '2026-01-01 00:00:09', blocked: prompt },
        { workingSince: '2026-01-01 00:00:09', blocked: prompt },
        { workingSince: '2026-01-01 00:00:09', blocked: null },
      ]),
    ).toBe(1)
  })

  it('two separate blocks are reported twice', () => {
    expect(
      noticesOver([
        { workingSince: '2026-01-01 00:00:05', blocked: null },
        { workingSince: '2026-01-01 00:00:05', blocked: prompt },
        { workingSince: '2026-01-01 00:00:09', blocked: null },
        { workingSince: '2026-01-01 00:00:09', blocked: prompt },
      ]),
    ).toBe(2)
  })
})
