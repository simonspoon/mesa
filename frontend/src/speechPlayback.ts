/**
 * Playhead arithmetic for the inbox's read-aloud player (mesa task 827).
 *
 * The speak route streams: chunked, no `Content-Length`, no range support. The
 * only audio a player can go back to is therefore what it has already
 * buffered, which the element reports as its `seekable` ranges — so a rewind
 * is a clamp against the earliest seekable second, not a subtraction.
 */

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
