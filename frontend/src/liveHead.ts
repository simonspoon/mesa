/**
 * The conversation panel's head — the compact strip above the transcript
 * (mesa task 1069).
 *
 * Until now the panel led with one sentence (`liveSession.ts::liveStatusLine`)
 * and the only *picture* of the conversation was an 18px canvas centered in
 * the page header, where it had to answer for a conversation whose panel was
 * usually shut. The head is where both belong once the panel is the surface
 * the person is actually looking at: the aperture, a word for what is
 * happening, how loud the room is, and how long this has been going on.
 *
 * Everything here is presentation, and deliberately pure — the ranking below
 * is the same one `liveIndicator.ts` and `liveStatusLine` already make, said
 * in one word instead of a drawing or a sentence, and the two clocks are
 * arithmetic the component would otherwise do inline in JSX.
 */

import type { LiveButton } from './liveSession'

/** The word the head leads with. A closed vocabulary: the head is one line
 *  of ~14px display type, so every state has to fit in two words. */
export type LiveHeadTitle =
  'Live' | 'Hearing you' | 'mesa speaking' | 'Paused' | 'Reconnecting' | 'Disconnected'

/**
 * What the head says, in the precedence the rest of the surface already uses.
 *
 * The order is `liveStatusLine`'s and `headerIndicator`'s merged, and neither
 * is re-litigated here:
 *
 * - **An error outranks everything** (`liveStatusLine`'s first arm). A head
 *   that reads "hearing you" while the last call failed is the one way this
 *   line can lie; the status line under it says what actually broke, so the
 *   title only has to say that the page is out of touch and trying again —
 *   which the 2s poll genuinely is.
 * - **A conversation that is not running comes next**, for `liveStatusLine`'s
 *   reason: those two arms describe the *session*, which none of the states
 *   below can change.
 * - **mesa speaking, then paused, then hearing** — `headerIndicator`'s
 *   ranking exactly, including why speaking sits above paused (a tail of
 *   audio still sounding is audio) and why paused sits above hearing (a draft
 *   left in the box from before the pause is not the person still talking).
 * - **Everything else is "Live"** — including the agent working, which the
 *   aperture beside this word says in violet and which has no two-word name
 *   of its own that is not just "working" restating the animation.
 */
export function liveHeadTitle(input: {
  /** The conversation is running (`liveSession.ts::isLive`). */
  live: boolean
  /** mesa's own audio is sounding. */
  speaking: boolean
  /** The person stepped out without ending it. */
  paused: boolean
  /** What the engine is still guessing at, or what is in the capture box —
   *  the same pair `headerIndicator` reads, and for the same reason. */
  interim: string
  draft: string
  /** The last failure this page has to report, or null. */
  error: string | null
}): LiveHeadTitle {
  if (input.error !== null) return 'Reconnecting'
  if (!input.live) return 'Disconnected'
  if (input.speaking) return 'mesa speaking'
  if (input.paused) return 'Paused'
  if (input.interim.trim() !== '' || input.draft.trim() !== '') return 'Hearing you'
  return 'Live'
}

/**
 * How long the conversation has been going, as `MM:SS`.
 *
 * Minutes are not rolled into hours: this is a stopwatch on one conversation
 * read at a glance beside a title, and `1:01:01` is a wider, more punctuated
 * thing to parse than `61:01` for a case that barely happens. A clock-skewed
 * future start clamps at `00:00` rather than printing a negative, the same
 * choice `timeAgo` makes.
 */
export function elapsedLabel(startedAtMs: number, nowMs: number): string {
  const secs = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000))
  const mins = Math.floor(secs / 60)
  return `${String(mins).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`
}

/** How many bars the head's level meter holds. */
export const METER_BARS = 12

/**
 * How many animation frames one bar stands for. The meter is a *history*, not
 * a level: at 60fps a bar per frame would scroll the whole 12 off screen in a
 * fifth of a second, which reads as noise. Five frames is ~12 bars a second —
 * slow enough that a syllable is a bar rather than a blur, fast enough that
 * the row still moves while someone is talking.
 */
export const METER_FRAMES_PER_BAR = 5

/**
 * The scrolling bar history: newest on the right, oldest falling off the left.
 *
 * Called every frame, and **returns the array it was given** on the frames
 * that change nothing — the caller compares by reference to decide whether to
 * render at all, so the rAF loop driving this costs one modulo on four frames
 * out of five. `level` is clamped rather than trusted: it comes from a
 * microphone, and a bar taller than its track is a layout bug rather than a
 * loud room.
 */
export function pushMeterHistory(
  history: number[],
  level: number,
  tick: number,
): number[] {
  if (tick % METER_FRAMES_PER_BAR !== 0) return history
  const kept = history.slice(-(METER_BARS - 1))
  const next = [...kept, Math.min(1, Math.max(0, level))]
  while (next.length < METER_BARS) next.unshift(0)
  return next
}

/** A meter with nothing in it yet — all twelve slots silent. */
export function emptyMeterHistory(): number[] {
  return new Array<number>(METER_BARS).fill(0)
}

/**
 * Whether the press that ends the conversation belongs in the panel head
 * rather than the page header (mesa task 1069).
 *
 * Ending lives beside Pause now, where the conversation itself is, and the
 * header keeps only the presses that *start* one. The exception is a press
 * already in flight: `Going live…` is labelled `stop` while the spawn is
 * running (`liveSession.ts`), and moving that into a panel the person has
 * probably not opened would take the only feedback the header has for it.
 * So: a real, pressable End moves; a disabled placeholder stays put.
 */
export function endsInHead(button: LiveButton | null): boolean {
  return button !== null && button.action === 'stop' && !button.disabled
}
