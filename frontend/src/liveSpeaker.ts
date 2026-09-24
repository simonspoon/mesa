/**
 * Which browser says a live conversation out loud (mesa task 1267).
 *
 * Every page that has ever pressed Go live or Listen has audio unlocked and
 * independently satisfies the run's own predicate, so two mesa tabs open on
 * one session each spoke every reply — the same sentence twice, half a beat
 * apart. `played_at` cannot settle it: it is stamped once a turn has finished
 * sounding, which makes it a record of what was said rather than a claim on
 * what is about to be, and the set of turns a page has taken in hand is that
 * page's own React state.
 *
 * So the session names **one speaker**, and this module is the browser's half
 * of that: an id of its own, and the one predicate that decides whether it
 * may speak. Both live here rather than in `LiveHub.tsx` for the reason
 * CLAUDE.md gives — a predicate that decides whether audio plays is exactly
 * the kind that has historically shipped wrong inline in a component.
 *
 * The id is this browser's alone, in the `liveSidebarWidth.ts` posture:
 * machine-local, opaque, never shown, never spoken, never sent to the agent.
 * The server sees it only as the two clients' way of telling each other
 * apart.
 */

import { spokenText } from './liveTurns'
import type { LiveTurn } from './types/LiveTurn'

const CLIENT_KEY = 'mesa-live-client'

/** Longest id this module will ever store or answer, matching `Store`'s own
 *  bound — a hand-edited `localStorage` value is as untrusted as any other
 *  stored one, and an id the server would refuse is worse than a fresh one. */
export const MAX_LIVE_CLIENT_ID = 64

function freshClientId(): string {
  // `randomUUID` needs a secure context, which mesa's own origins are — but a
  // page served some other way should get an id rather than an exception. The
  // fallback does not have to be unguessable: two ids only ever have to
  // differ, and nothing is authorised by one.
  const uuid: string | undefined = globalThis.crypto?.randomUUID?.()
  if (uuid !== undefined && uuid !== '') return uuid
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * This browser's id, generated once and kept. Stable across reloads, which is
 * what lets a page that reloads mid-conversation go on being the speaker
 * rather than starting an echo with itself.
 *
 * A storage that refuses to answer or to keep (private mode, a disabled
 * store) costs the page nothing but stability: it gets a fresh id for this
 * load and claims with that.
 */
export function liveClientId(): string {
  let stored: string | null
  try {
    stored = localStorage.getItem(CLIENT_KEY)
  } catch {
    stored = null
  }
  const trimmed = stored?.trim() ?? ''
  if (trimmed !== '' && trimmed.length <= MAX_LIVE_CLIENT_ID) return trimmed
  const fresh = freshClientId()
  try {
    localStorage.setItem(CLIENT_KEY, fresh)
  } catch {
    // Nothing to do and nothing to report: an unstored id still works for
    // this page's life, which is the whole of what a claim needs.
  }
  return fresh
}

/**
 * Whether this browser may speak the conversation's turns.
 *
 * Two escape hatches, both deliberate, and both are why this is not simply
 * `speaker === client`:
 *
 * - **Nobody has claimed it** (`null`) — every unlocked client may speak,
 *   which is exactly what mesa did before the claim existed. A client that
 *   knows nothing of this rule, or one on a build that never sends a claim,
 *   is never silenced by it.
 * - **The claim has gone stale** — which the page does not compute: the
 *   server derives `speaker`, refreshed by the claiming browser's own route
 *   report, and answers `null` once it has not been refreshed for ten
 *   seconds. A tab that was closed therefore frees the voice rather than
 *   leaving the conversation mute, and this predicate reads that as the
 *   unclaimed case above. Judging it here would mean trusting the browser's
 *   clock against the store's.
 */
export function maySpeak(speaker: string | null, client: string): boolean {
  return speaker === null || speaker === client
}

/**
 * How often a still page holding the voice re-sends its route report, which
 * is the only thing that refreshes the claim (mesa task 1342). Well under the
 * server's ten-second expiry, so one lost report — or a poll tick that lands a
 * little late — never lets the claim lapse under a page nobody has touched.
 */
export const SPEAKER_REFRESH_MS = 4000

/**
 * Whether the route report must be sent even though nothing in it changed.
 *
 * The report is deduped — a window nobody touched has nothing new to say —
 * but it is also what keeps this browser's claim alive, so a page that holds
 * the voice and has not reported for `SPEAKER_REFRESH_MS` sends it anyway.
 * A page that does not hold it (another browser does, or nobody does) answers
 * `false`: its report could refresh nothing, since `touch_live_speaker` is a
 * no-op for a non-speaker, so it goes on posting nothing at all.
 */
export function needsSpeakerRefresh(
  speaker: string | null,
  client: string,
  lastReportedAt: number,
  now: number,
): boolean {
  return (
    speaker !== null &&
    speaker === client &&
    now - lastReportedAt >= SPEAKER_REFRESH_MS
  )
}

/**
 * Whether this page may take a turn **in hand to speak it** — it has words,
 * and this browser is the one saying them.
 *
 * The one decision `run()` files a turn into `handled` on, and therefore the
 * one that must be exactly right: a page that answers `false` here has
 * consumed nothing, so the turn is still on `pendingTurns` for whoever ends up
 * with the voice — including this very page, once a claim goes stale.
 * Answering `false` for a turn that says nothing keeps the pure-action path
 * (which every browser runs, and which stamps `played_at` itself) out of the
 * speech path entirely.
 */
export function takesToSpeak(
  turn: LiveTurn,
  speaker: string | null,
  client: string,
): boolean {
  return spokenText(turn) !== null && maySpeak(speaker, client)
}

/**
 * What `run()` does with a turn it reaches that has words (mesa task 1327):
 *
 * - `leave` — another browser holds the voice (`takesToSpeak` is false), so
 *   the turn is taken in hand for nothing and stays pending for the speaker.
 * - `speak` — this page says it.
 * - `read` — this page would say it, but the person has muted Naru's voice on
 *   this browser. The words are on screen, so the turn counts as heard:
 *   taken in hand and stamped `played_at` exactly as a spoken one is, which
 *   is why unmuting never replays what arrived while muted.
 *
 * Muting deliberately sits *under* the claim rather than beside it: it
 * changes what the page holding the voice does with a turn, never who holds
 * it, so a muted speaker keeps the conversation silent rather than quietly
 * handing its voice to some other open tab.
 */
export type SpokenTurnVerdict = 'leave' | 'speak' | 'read'

export function spokenTurnVerdict(
  turn: LiveTurn,
  speaker: string | null,
  client: string,
  speechMuted: boolean,
): SpokenTurnVerdict {
  if (!takesToSpeak(turn, speaker, client)) return 'leave'
  return speechMuted ? 'read' : 'speak'
}
