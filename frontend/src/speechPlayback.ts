/**
 * The decisions behind the inbox's read-aloud player: where a rewind press
 * lands (mesa task 827), and what a failed play leaves to try (mesa task 829).
 *
 * The speak route streams: chunked, no `Content-Length`, no range support. The
 * only audio a player can go back to is therefore what it has already
 * buffered, which the element reports as its `seekable` ranges — so a rewind
 * is a clamp against the earliest seekable second, not a subtraction.
 */

/**
 * What a media `error` event on the shared player means (mesa task 829):
 *
 * - `ignore` — not about the audio we asked for: a player whose source was
 *   cleared (how playback is stopped) or one still holding another item's.
 *   Reacting to either would restart something the page has moved on from.
 * - `buffer` — the streamed body failed. Apple's media stack refuses an HTTP
 *   source with no byte-range support, which is exactly this route's shape, so
 *   the audio is re-requested whole and played from a blob instead.
 * - `report` — the fallback failed too, so there is nothing left to try.
 */
export type PlayFailure = 'ignore' | 'buffer' | 'report'

/**
 * Reads a player error against the source it was asked to play. `src` is the
 * element's own (already absolute), `streamUrl` the speak route this press
 * started from, `buffered` whether that press had already fallen back.
 */
export function playFailure(
  src: string,
  streamUrl: string,
  buffered: boolean,
): PlayFailure {
  if (src.startsWith('blob:')) return 'report'
  if (!src.endsWith(streamUrl)) return 'ignore'
  return buffered ? 'report' : 'buffer'
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
