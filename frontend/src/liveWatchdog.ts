import type { LiveNotice } from './types/LiveNotice'
import type { LiveTurn } from './types/LiveTurn'

/**
 * The page-side watchdog over the live agent (mesa task 1157).
 *
 * By voice, silence is confusing: the agent may be thinking or may be stuck
 * on a Claude Code permission prompt nobody can see — and it cannot report
 * the prompt itself, so the *page* does. One report, posted to
 * `POST /api/live/notice` and written by the server as a `mesa` turn (spoken
 * once, labelled in the transcript, deduped per working span by
 * `Store::add_live_notice`):
 *
 * - `permission` — `GET /api/live` answers a non-null `blocked` (the job's
 *   `waitingFor`, read off `claude agents`) where the previous poll answered
 *   null — the **rising edge** — and no such notice exists in this span yet.
 *
 * A second report, `stalled` (working and silent for 30 s), was removed by
 * mesa task 1218: real work routinely runs longer, so it was spoken on
 * almost every turn and told the person nothing.
 *
 * The permission notice is edge-triggered rather than level-triggered because
 * `blocked` is a cached read (5 s server-side): the prompt being answered
 * opens a new working span while the cache still says "permission prompt",
 * and a level rule would report the prompt again in the new span. A value
 * that merely persists across a span change is not news; only null → non-null
 * is. The server's per-span dedupe stays as the second line. Every decision
 * here is a pure function of its inputs, so `LiveHub` only performs them, on
 * every poll.
 */

/** What the page remembers of one conversation between polls. */
export interface Watchdog {
  /** Which session this belongs to; a new one starts afresh. */
  sessionId: number
  /** The `blocked` the last poll answered, so a new block is an edge. */
  blocked: string | null
}

/** A fresh watchdog for a conversation this page has just started watching. */
export function initialWatchdog(sessionId: number): Watchdog {
  return { sessionId, blocked: null }
}

/** The watchdog after a poll lands: it remembers that poll's `blocked`. */
export function watchdogAfterPoll(prev: Watchdog, input: { blocked: string | null }): Watchdog {
  return { sessionId: prev.sessionId, blocked: input.blocked }
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
