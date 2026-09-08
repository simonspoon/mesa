import { diffLines } from './libraryOverride'
import type { LibraryDiffLine } from './types/LibraryDiffLine'
import type { LibraryVersion } from './types/LibraryVersion'

/**
 * Pure decisions for the Library page's history panel: turning the version
 * list `GET /api/library/{id}/versions` answers into the entries the panel
 * renders — each version paired with the one immediately *older* than it, the
 * diff between the two, and the line counts that diff carries.
 *
 * The counts are read off the very `LibraryDiffLine[]` the panel renders, not
 * computed a second way, so a list line saying `+3 -1` and the diff opened
 * beside it can never disagree. `diffLines` is bounded twice and degrades to a
 * marker line rather than a short answer (`libraryOverride.ts`); a diff
 * carrying one is an incomplete statement, so it is reported with **no**
 * counts rather than counts of the part that fits.
 */

/** One row of the version list, and everything the panel beside it renders. */
export type HistoryEntry = {
  version: LibraryVersion
  /** The body of the version immediately older, `null` for the oldest. */
  previousBody: string | null
  /** The diff of `previousBody` → this body, `null` for the oldest. Lines
   * only in the older body are `mesa-only` (`-`), lines only in this one are
   * `disk-only` (`+`) — the direction `diffLineClass`/`diffMark` already
   * paint. */
  diff: LibraryDiffLine[] | null
  /** Lines this version added / removed against the previous one; `null`
   * where there is nothing to compare or the diff is incomplete. */
  added: number | null
  removed: number | null
  /** What the list line calls this version's source. */
  sourceLabel: string
}

/** A line that is neither side's content — how `diffLines` says it stopped.
 * Its presence makes any count off that diff a partial answer. */
function isMarker(line: LibraryDiffLine): boolean {
  return line.mesa_line === null && line.disk_line === null
}

/** The `+added / -removed` pair for one diff, or `null` when the diff is
 * incomplete and the honest answer is no number at all. */
function countsFor(diff: LibraryDiffLine[]): { added: number; removed: number } | null {
  if (diff.some(isMarker)) return null
  let added = 0
  let removed = 0
  for (const line of diff) {
    if (line.kind === 'disk-only') added++
    else if (line.kind === 'mesa-only') removed++
  }
  return { added, removed }
}

/**
 * The panel's entries, in the order the versions arrived — the API answers
 * newest first, and the list is read that way. The last entry is the oldest
 * version: it has no previous body, so no diff and no counts, and its source
 * reads `created` however it is stored (version 1's stored `source` is
 * `edit`, which is true of every later one too and so says nothing here).
 */
export function historyEntries(versions: LibraryVersion[]): HistoryEntry[] {
  return versions.map((version, i) => {
    const oldest = i === versions.length - 1
    const previousBody = oldest ? null : versions[i + 1].body
    const diff = previousBody === null ? null : diffLines(previousBody, version.body)
    const counts = diff === null ? null : countsFor(diff)
    return {
      version,
      previousBody,
      diff,
      added: counts?.added ?? null,
      removed: counts?.removed ?? null,
      sourceLabel: oldest ? 'created' : version.source,
    }
  })
}
