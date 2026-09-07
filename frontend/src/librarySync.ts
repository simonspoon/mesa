import type { LibraryDiffLine } from './types/LibraryDiffLine'
import type { LibrarySyncResult } from './types/LibrarySyncResult'
import type { LibrarySyncRow } from './types/LibrarySyncRow'
import type { LibrarySyncStatus } from './types/LibrarySyncStatus'

/**
 * Pure decisions for the Library page's Sync modal, hoisted out of the
 * component so they are unit-testable (CLAUDE.md: the frontend tests cover
 * the pure logic modules, not a rendered tree). These are exactly the
 * "predicates that historically shipped wrong" CLAUDE.md warns about — one
 * status, one row, one resolution, decided the same way everywhere.
 *
 * A resolution is one of three choices, matching the API
 * (`.scratch/library-design.md`): `mesa` (push the stored body to disk),
 * `disk` (pull the file's body into mesa) or `skip` (do nothing, move the
 * baseline not at all). There is deliberately no fourth "merge" choice — the
 * modal shows both bodies and the user picks a side.
 */

/**
 * A key that cannot collide across two rows, even when they share a `path`
 * (the backend scan is not guaranteed to keep paths unique — see mesa task
 * 919's QA notes). Used both as the React `key` for the row list and as the
 * radio-group `name` for a row's mesa/disk/skip picker: a bare `row.path` in
 * either spot lets two same-path rows interfere — clicking one row's radio
 * silently unchecks the other's (native HTML radio grouping is keyed by
 * `name` alone), and a stale row can survive a refetch (a React key
 * collision leaves an old node behind across the diff). The index is safe to
 * fold in because this list is never reordered in place.
 */
export function rowKey(row: LibrarySyncRow, index: number): string {
  return `${row.item_id ?? 'b'}-${row.builtin_id ?? ''}-${row.path}-${index}`
}

/** One line naming a status, for a row's badge. */
export function statusLabel(status: LibrarySyncStatus): string {
  switch (status) {
    case 'in-sync':
      return 'In sync'
    case 'mesa-new':
      return 'New in mesa'
    case 'disk-deleted':
      return 'Deleted on disk'
    case 'mesa-changed':
      return 'Changed in mesa'
    case 'disk-changed':
      return 'Changed on disk'
    case 'both-changed':
      return 'Conflict'
    case 'disk-new':
      return 'New on disk'
  }
}

/** One sentence per status, saying what accepting each side would actually
 * do — the modal shows this beside the diff so a resolution is never a blind
 * guess at what "mesa" or "disk" means for this particular row. */
export function statusExplains(status: LibrarySyncStatus): string {
  switch (status) {
    case 'in-sync':
      return 'The stored copy and the file on disk already match.'
    case 'mesa-new':
      return 'This item has never been written to disk. Choosing mesa writes the file; choosing disk or skip leaves it missing.'
    case 'disk-deleted':
      return 'The file was deleted from disk since the last sync. Choosing disk deletes the stored copy too; choosing mesa writes the file back.'
    case 'mesa-changed':
      return 'The stored copy changed since the last sync and the file on disk has not. Choosing mesa overwrites the file; choosing disk discards that change and reverts to what is on disk.'
    case 'disk-changed':
      return "The file on disk changed since the last sync and the stored copy has not. Choosing disk pulls the file's contents in; choosing mesa overwrites the file with the old stored copy."
    case 'both-changed':
      return 'Both sides changed since the last sync — a real conflict. Choosing mesa overwrites the file with the stored copy; choosing disk discards the stored change and pulls the file in.'
    case 'disk-new':
      return 'A file exists on disk with no matching item in the library. Choosing disk adopts it into the library; choosing mesa or skip leaves it alone.'
  }
}

/** True for a status where exactly one side actually changed since the
 * baseline — the case a resolution can default without guessing. */
export function isOneSided(row: LibrarySyncRow): boolean {
  return (
    row.status === 'mesa-new' ||
    row.status === 'disk-deleted' ||
    row.status === 'mesa-changed' ||
    row.status === 'disk-changed'
  )
}

/** False only for `in-sync` — every other status is something the sync modal
 * should surface to the user rather than silently drop. */
export function needsAttention(row: LibrarySyncRow): boolean {
  return row.status !== 'in-sync'
}

/**
 * The choice a fresh modal pre-selects for this row. The one-sided statuses
 * pre-select the side that actually changed (accepting the change is the
 * obvious default); the two-sided ones — `both-changed`, a real conflict, and
 * `disk-new`, adopting an unfamiliar file — pre-select `skip`, so neither is
 * ever resolved by inertia (a batch apply with no attention paid).
 */
export function defaultChoice(row: LibrarySyncRow): 'mesa' | 'disk' | 'skip' {
  switch (row.status) {
    case 'mesa-new':
    case 'mesa-changed':
      return 'mesa'
    case 'disk-deleted':
    case 'disk-changed':
      return 'disk'
    case 'in-sync':
    case 'both-changed':
    case 'disk-new':
      return 'skip'
  }
}

/** Counts by status, for the modal's summary line. */
export function summarize(rows: LibrarySyncRow[]): Record<LibrarySyncStatus, number> {
  const counts: Record<LibrarySyncStatus, number> = {
    'in-sync': 0,
    'mesa-new': 0,
    'disk-deleted': 0,
    'mesa-changed': 0,
    'disk-changed': 0,
    'both-changed': 0,
    'disk-new': 0,
  }
  for (const row of rows) {
    counts[row.status] += 1
  }
  return counts
}

/**
 * The `resolutions` array for `POST /api/library/sync`: one entry per row
 * that needs one, `in-sync` rows omitted entirely (there is nothing to
 * apply, and sending one would move a baseline that never disagreed).
 * `choices` holds whatever the user has explicitly picked, keyed by path; a
 * row missing from it falls back to `defaultChoice`, so a batch the user
 * never touched still applies the same sensible one-sided defaults.
 */
export function resolutionsFor(
  rows: LibrarySyncRow[],
  choices: Record<string, 'mesa' | 'disk' | 'skip'>,
): { path: string; choice: 'mesa' | 'disk' | 'skip' }[] {
  return rows
    .filter((row) => row.status !== 'in-sync')
    .map((row) => ({
      path: row.path,
      choice: choices[row.path] ?? defaultChoice(row),
    }))
}

/**
 * The one line to show for an apply result. `applied: false, error: null` is
 * the server's honest report of a `skip` — nothing was applied and nothing
 * went wrong, so it reads as "skipped", never "failed". Only a non-null
 * `error` is an actual failure; `applied` alone does not mean "ok" the way a
 * naive `applied ? 'applied' : 'failed'` would render it.
 */
export function resultLabel(result: LibrarySyncResult): string {
  if (result.applied) return 'applied'
  if (result.error !== null) return `failed — ${result.error}`
  return 'skipped'
}

/**
 * True when the row carries a line-level diff worth showing. The server sends
 * one only for a two-sided row that actually differs, so this is a length
 * check on top of the null one — an empty array is not a view.
 */
export function hasDiff(row: LibrarySyncRow): boolean {
  return row.diff !== null && row.diff.length > 0
}

/** The CSS class for one diff line. A `context` line carrying neither line
 * number is `diff_lines`'s truncation marker, not content, and reads as its
 * own thing rather than as an unchanged line of somebody's file. */
export function diffLineClass(line: LibraryDiffLine): string {
  if (line.kind === 'mesa-only') return 'library-diff-line library-diff-mesa'
  if (line.kind === 'disk-only') return 'library-diff-line library-diff-disk'
  if (line.mesa_line === null && line.disk_line === null) {
    return 'library-diff-line library-diff-marker'
  }
  return 'library-diff-line library-diff-context'
}

/** The one-character gutter mark for a diff line — the diff convention, with
 * a blank for context and for the truncation marker. */
export function diffMark(line: LibraryDiffLine): string {
  if (line.kind === 'mesa-only') return '-'
  if (line.kind === 'disk-only') return '+'
  return ' '
}

/**
 * Which side changed more recently, or `null` when either date is missing (a
 * one-sided row, an unshadowed built-in, a filesystem with no mtime). Both
 * dates are mesa's `YYYY-MM-DD HH:MM:SS` UTC text, so they compare as
 * strings — no Date parsing, and no local-timezone reinterpretation of a UTC
 * value.
 */
export function newerSide(row: LibrarySyncRow): 'mesa' | 'disk' | 'same' | null {
  const mesa = row.mesa_updated_at
  const disk = row.disk_mtime
  if (mesa === null || disk === null) return null
  if (mesa === disk) return 'same'
  return mesa > disk ? 'mesa' : 'disk'
}

/** The two change dates as one short line above a row's diff, naming which
 * side is which and which is newer. `null` when neither side has a date —
 * there is nothing to say, and an empty line is not worth the space. */
export function changeDatesLabel(row: LibrarySyncRow): string | null {
  const parts: string[] = []
  if (row.mesa_updated_at !== null) parts.push(`mesa ${shortDate(row.mesa_updated_at)}`)
  if (row.disk_mtime !== null) parts.push(`disk ${shortDate(row.disk_mtime)}`)
  if (parts.length === 0) return null
  const newer = newerSide(row)
  const verdict =
    newer === 'mesa'
      ? ' (mesa is newer)'
      : newer === 'disk'
        ? ' (disk is newer)'
        : newer === 'same'
          ? ' (same time)'
          : ''
  return `${parts.join(' · ')}${verdict}`
}

/** `YYYY-MM-DD HH:MM:SS` cut to the minute — seconds are noise for "which of
 * these two is newer". Anything not of that shape is shown verbatim. */
function shortDate(ts: string): string {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts) ? ts.slice(0, 16) : ts
}
