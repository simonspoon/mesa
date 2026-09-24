import type { LibraryItem } from './types/LibraryItem'

/**
 * A fork whose built-in changed under it (mesa task 1349): the server derives
 * `builtin_updated` and ships the current built-in body beside the fork's, so
 * the review panel diffs two strings the page already holds.
 *
 * Returns the two bodies the review compares, or `null` when the row has
 * nothing to review — not a stored row (an unshadowed built-in is the new body
 * already), not flagged, or its built-in is gone from this build.
 */
export function builtinReview(item: LibraryItem): { fork: string; builtin: string } | null {
  if (item.id === null || !item.builtin_updated || item.builtin_body === null) return null
  return { fork: item.body, builtin: item.builtin_body }
}
