import type { LiveNotice } from './types/LiveNotice'
import type { LiveTurn } from './types/LiveTurn'

/**
 * The page-side watchdog over the live agent (mesa task 1157).
 *
 * By voice, silence is confusing: the agent may be thinking, may be stuck on
 * a Claude Code permission prompt nobody can see, or may simply have wedged —
 * and it cannot report any of that itself, so the *page* does. Two reports,
 * each posted to `POST /api/live/notice` and written by the server as a
 * `mesa` turn (spoken once, labelled in the transcript, deduped per working
 * span by `Store::add_live_notice`):
 *
 * - `permission` — `GET /api/live` answers a non-null `blocked` (the job's
 *   `waitingFor`, read off `claude agents`) where the previous poll answered
 *   null — the **rising edge** — and no such notice exists in this span yet;
 * - `stalled` — the session is working (`working_since` non-null), mesa is
 *   not speaking, nothing has happened for `STALL_MS`, and no such notice
 *   exists in this span yet — and the session is not **resting**
 *   (`resting_since`, mesa task 1155): a successor deliberately idle while
 *   the dream pass runs is silent on purpose, not stuck.
 *
 * "Nothing has happened" is the page's own clock, `lastActivityAt`, reset
 * when a working span **begins** (`working_since` changes to a new value),
 * when a **new mesa turn** arrives, and when **mesa's playback ends** — the
 * last because a long spoken reply is the opposite of silence, and a clock
 * that kept running through it would call a two-minute answer a stall the
 * moment it finished. Every decision here is a pure function of its inputs,
 * with `now` passed in, so `LiveHub` only performs them — on every poll, and
 * on a one-second tick between polls, since silence is exactly the case
 * where no poll changes anything and a check that waits for one never runs.
 *
 * The permission notice is edge-triggered rather than level-triggered because
 * `blocked` is a cached read (5 s server-side): the prompt being answered
 * opens a new working span while the cache still says "permission prompt",
 * and a level rule would report the prompt again in the new span. A value
 * that merely persists across a span change is not news; only null → non-null
 * is. The server's per-span dedupe stays as the second line.
 */

/** How long the agent may be working in silence before the page says so. */
export const STALL_MS = 30000

/** The page's clock on one conversation. */
export interface Watchdog {
  /** Which session the clock belongs to; a new one starts a new clock. */
  sessionId: number
  /** The `working_since` the clock last saw, so a new span is an edge. */
  workingSince: string | null
  /** The highest mesa-turn id seen, so a new turn is an edge. */
  lastTurnId: number | null
  /** The `blocked` the last poll answered, so a new block is an edge. */
  blocked: string | null
  /** When something last happened, on the page's clock. */
  lastActivityAt: number
}

/** A fresh clock for a conversation this page has just started watching. */
export function initialWatchdog(sessionId: number, now: number): Watchdog {
  return { sessionId, workingSince: null, lastTurnId: null, blocked: null, lastActivityAt: now }
}

/**
 * The clock after a poll lands: reset when a working span begins or a new
 * mesa turn arrives, otherwise carried forward. A span *ending* (`working_since`
 * back to null) is not activity — nothing is judged while not working anyway —
 * but it is remembered, so the next span is an edge again. A user turn is
 * never activity: the person talking says nothing about the agent.
 *
 * `turns` must be the transcript **of the same poll** as `workingSince` and
 * `blocked`: judged against an older transcript, the mesa turn that ended a
 * long silence is not yet seen, and the stale clock reports a stall one
 * second after the reply. Re-running this on a tick with an unchanged poll
 * is a no-op — the turn id only ever rises, so nothing is an edge twice.
 */
export function watchdogAfterPoll(
  prev: Watchdog,
  input: {
    workingSince: string | null
    turns: readonly LiveTurn[]
    blocked: string | null
    now: number
  },
): Watchdog {
  let lastTurnId = prev.lastTurnId
  for (const turn of input.turns) {
    if (turn.role === 'mesa' && (lastTurnId === null || turn.id > lastTurnId)) {
      lastTurnId = turn.id
    }
  }
  const newTurn = lastTurnId !== prev.lastTurnId
  const newSpan = input.workingSince !== null && input.workingSince !== prev.workingSince
  return {
    sessionId: prev.sessionId,
    workingSince: input.workingSince,
    lastTurnId,
    blocked: input.blocked,
    lastActivityAt: newTurn || newSpan ? input.now : prev.lastActivityAt,
  }
}

/** The clock after mesa finished saying something: that was activity. */
export function watchdogAfterSpeech(prev: Watchdog, now: number): Watchdog {
  return { ...prev, lastActivityAt: now }
}

/**
 * Whether a notice of `kind` already exists in the current span — the same
 * rule the server dedupes by, `created_at >= COALESCE(working_since,
 * started_at)`, so the page never posts what the server would refuse anyway.
 * Both stamps are SQLite `datetime` text in one format, so string order is
 * time order.
 */
export function noticeInSpan(
  turns: readonly LiveTurn[],
  kind: LiveNotice,
  spanStart: string,
): boolean {
  return turns.some((turn) => turn.notice === kind && turn.created_at >= spanStart)
}

/** Whether to post `stalled` now. Never while resting: the successor is
 *  waiting out the dream pass on purpose. */
export function shouldNoticeStalled(input: {
  working: boolean
  speaking: boolean
  /** The session's `resting_since` is set (mesa task 1155). */
  resting: boolean
  now: number
  lastActivityAt: number
  alreadyNoticed: boolean
}): boolean {
  if (!input.working || input.speaking || input.resting || input.alreadyNoticed) return false
  return input.now - input.lastActivityAt >= STALL_MS
}

/**
 * Whether to post `permission` now: only on the rising edge — this poll
 * answers a block where the previous one (`wasBlocked`) answered none — and
 * never already reported in this span.
 */
export function shouldNoticePermission(input: {
  blocked: string | null
  wasBlocked: string | null
  alreadyNoticed: boolean
}): boolean {
  return input.blocked !== null && input.wasBlocked === null && !input.alreadyNoticed
}
