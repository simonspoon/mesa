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
 *   `waitingFor`, read off `claude agents`) and no such notice exists in this
 *   span yet;
 * - `stalled` — the session is working (`working_since` non-null), mesa is
 *   not speaking, nothing has happened for `STALL_MS`, and no such notice
 *   exists in this span yet.
 *
 * "Nothing has happened" is the page's own clock, `lastActivityAt`, reset
 * when a working span **begins** (`working_since` changes to a new value),
 * when a **new mesa turn** arrives, and when **mesa's playback ends** — the
 * last because a long spoken reply is the opposite of silence, and a clock
 * that kept running through it would call a two-minute answer a stall the
 * moment it finished. Every decision here is a pure function of its inputs,
 * with `now` passed in, so `LiveHub` only performs them.
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
  /** When something last happened, on the page's clock. */
  lastActivityAt: number
}

/** A fresh clock for a conversation this page has just started watching. */
export function initialWatchdog(sessionId: number, now: number): Watchdog {
  return { sessionId, workingSince: null, lastTurnId: null, lastActivityAt: now }
}

/**
 * The clock after a poll lands: reset when a working span begins or a new
 * mesa turn arrives, otherwise carried forward. A span *ending* (`working_since`
 * back to null) is not activity — nothing is judged while not working anyway —
 * but it is remembered, so the next span is an edge again. A user turn is
 * never activity: the person talking says nothing about the agent.
 */
export function watchdogAfterPoll(
  prev: Watchdog,
  input: { workingSince: string | null; turns: readonly LiveTurn[]; now: number },
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

/** Whether to post `stalled` now. */
export function shouldNoticeStalled(input: {
  working: boolean
  speaking: boolean
  now: number
  lastActivityAt: number
  alreadyNoticed: boolean
}): boolean {
  if (!input.working || input.speaking || input.alreadyNoticed) return false
  return input.now - input.lastActivityAt >= STALL_MS
}

/** Whether to post `permission` now. */
export function shouldNoticePermission(input: {
  blocked: string | null
  alreadyNoticed: boolean
}): boolean {
  return input.blocked !== null && !input.alreadyNoticed
}
