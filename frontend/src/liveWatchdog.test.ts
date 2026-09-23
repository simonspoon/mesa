import { describe, expect, it } from 'vitest'
import {
  initialWatchdog,
  noticeInSpan,
  shouldNoticePermission,
  watchdogAfterPoll,
} from './liveWatchdog'
import type { LiveTurn } from './types/LiveTurn'

function turn(id: number, patch: Partial<LiveTurn> = {}): LiveTurn {
  return {
    id,
    session_id: 1,
    role: 'naru',
    text: 'one moment',
    action: null,
    target: null,
    notice: null,
    agent_id: null,
    created_at: '2026-01-01 00:00:10',
    delivered_at: null,
    played_at: null,
    ...patch,
  }
}

describe('noticeInSpan', () => {
  const spanStart = '2026-01-01 00:00:10'
  it('finds a notice of that kind at or after the span start', () => {
    expect(
      noticeInSpan([turn(1, { notice: 'permission', created_at: spanStart })], 'permission', spanStart),
    ).toBe(true)
    expect(
      noticeInSpan(
        [turn(1, { notice: 'permission', created_at: '2026-01-01 00:00:11' })],
        'permission',
        spanStart,
      ),
    ).toBe(true)
  })

  it('ignores an older span and plain turns', () => {
    expect(
      noticeInSpan(
        [turn(1, { notice: 'permission', created_at: '2026-01-01 00:00:09' })],
        'permission',
        spanStart,
      ),
    ).toBe(false)
    expect(noticeInSpan([turn(1, { created_at: spanStart })], 'permission', spanStart)).toBe(false)
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

  // Drives the watchdog through a sequence of polls and counts the notices a
  // page following the rule would post, `noticed` standing in for the
  // per-span memory (a span change forgets it, exactly as the page does).
  function noticesOver(polls: { workingSince: string; blocked: string | null }[]): number {
    let w = initialWatchdog(1)
    const noticed = new Set<string>()
    let posted = 0
    polls.forEach((poll) => {
      const prev = w
      w = watchdogAfterPoll(prev, { blocked: poll.blocked })
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
