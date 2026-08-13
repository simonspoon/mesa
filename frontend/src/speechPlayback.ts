/**
 * The decisions behind the inbox's read-aloud player: where a rewind press
 * lands (mesa task 827), what a failed play leaves to try (mesa task 829), and
 * when a scheduled buffer has to give up its place (mesa task 830).
 *
 * The speak route streams: chunked, no `Content-Length`, no range support. On
 * the element's path the only audio a player can go back to is therefore what
 * it has already buffered, which the element reports as its `seekable` ranges
 * — so a rewind is a clamp against the earliest seekable second, not a
 * subtraction. On the decoded path (`speechStream.ts`) the page holds every
 * sample it has been sent, so that floor is simply `0`; the same arithmetic
 * answers both.
 */

/**
 * What a media `error` event on the shared player means (mesa task 829):
 *
 * - `ignore` — not about the audio we asked for: a player whose source was
 *   cleared (how playback is stopped) or one still holding another item's.
 *   Reacting to either would restart something the page has moved on from.
 * - `decode` — the streamed body failed. Apple's media stack refuses an HTTP
 *   source with no byte-range support, which is exactly this route's shape, so
 *   the page fetches the same bytes and decodes them itself instead
 *   (`speechStream.ts`), which needs no ranges and still starts on the first
 *   sentence.
 */
export type PlayFailure = 'ignore' | 'decode'

/**
 * Reads a player error against the source it was asked to play. `src` is the
 * element's own (already absolute), `streamUrl` the speak route this press
 * started from.
 *
 * There is no third answer: once a page has fallen back it stops using the
 * element altogether, and a decoded play that fails hands back the reason it
 * failed for (`SpeechStreamEvents.onError`) rather than arriving here as a
 * reasonless `error` event.
 */
export function playFailure(src: string, streamUrl: string): PlayFailure {
  return src.endsWith(streamUrl) ? 'decode' : 'ignore'
}

/**
 * How far ahead of the clock a buffer that missed its slot is put instead
 * (mesa task 830). Long enough that scheduling it does not race the audio
 * thread, short enough not to be heard as a stall of its own.
 */
export const SCHEDULE_LEAD_SECONDS = 0.15

/**
 * When a decoded buffer should start, given the context clock `now` and the
 * `pending` time the item's timeline puts it at.
 *
 * A buffer whose slot is still ahead keeps it — that is what makes the audio
 * continuous. One whose slot has passed is a buffer the network did not
 * deliver in time (or the very first, which has no slot yet): starting it at
 * `now` would ask the audio thread for sound it has already played past, so it
 * goes a lead ahead and the item's clock slips by the difference. The
 * listener hears a gap, never a sample dropped.
 */
export function scheduleAt(now: number, pending: number): number {
  return pending > now ? pending : now + SCHEDULE_LEAD_SECONDS
}

/** A piece of decoded audio a rewind puts back on the clock. */
export interface Replay {
  /** Its place in the pieces the page is holding. */
  index: number
  /** How far into that piece playback resumes. */
  from: number
  /** How long after the restart it sounds. */
  delay: number
}

/**
 * Which of the pieces a decoded item is holding a rewind to `target` replays,
 * and where each one goes (mesa task 830). `played` is every piece in item
 * order, each with the second it starts at and how long it lasts.
 *
 * A piece entirely behind the target is not replayed at all; the one the
 * target lands inside resumes part-way through and sounds immediately, which
 * is what makes the rewind land on the second asked for rather than on a piece
 * boundary; the ones after it keep their spacing from that moment. Rewinding
 * is the one place the audio already heard is re-scheduled, so getting these
 * three numbers wrong is heard as a skip, a repeat, or a silence.
 */
export function replaySlices(
  played: readonly { at: number; duration: number }[],
  target: number,
): Replay[] {
  const slices: Replay[] = []
  played.forEach(({ at, duration }, index) => {
    if (at + duration <= target) return
    slices.push({
      index,
      from: Math.max(0, target - at),
      delay: Math.max(0, at - target),
    })
  })
  return slices
}

/** How far one rewind press goes back. */
export const REWIND_STEP_SECONDS = 10

/**
 * Where a rewind press should put the playhead, or `null` when it cannot move:
 * nothing is seekable yet (`seekableStart === null`), the numbers are not usable
 * (a stream reports `NaN`/`Infinity` before it has any timeline), or the
 * playhead already sits at the earliest second still available. `null` means
 * "do nothing" — never seek to the value anyway.
 */
export function rewindTarget(
  currentTime: number,
  seekableStart: number | null,
): number | null {
  if (seekableStart === null) return null
  if (!Number.isFinite(currentTime) || !Number.isFinite(seekableStart)) {
    return null
  }
  const target = Math.max(seekableStart, currentTime - REWIND_STEP_SECONDS)
  return target < currentTime ? target : null
}
