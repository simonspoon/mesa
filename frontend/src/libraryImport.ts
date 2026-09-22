import { datesLabel, type DiffOrientation } from './librarySync'
import type { LibraryImportRow } from './types/LibraryImportRow'
import type { LibraryImportStatus } from './types/LibraryImportStatus'

/**
 * Pure decisions for the Library page's Import modal (mesa task 1292),
 * hoisted out of `LibraryView.tsx` so they are unit-testable (CLAUDE.md: the
 * frontend tests cover the pure logic modules, never a rendered tree) — the
 * `librarySync.ts`/`libraryBundle.ts` pattern.
 *
 * An import resolution is two words, not sync's three: `replace` (take the
 * imported body) or `skip` (keep the row already here). A bundle carries no
 * sync baseline, so there is no third string to classify against and no
 * `mesa`/`disk` direction to pick — just two bodies and a choice.
 */

export type ImportChoice = 'skip' | 'replace'

/** The two choices, in the order the picker offers them, with the words the
 * person actually reads — `skip`/`replace` are the wire's, and "keep local"
 * / "take imported" is what they do. */
export const IMPORT_CHOICES: readonly { value: ImportChoice; label: string }[] = [
  { value: 'skip', label: 'keep local' },
  { value: 'replace', label: 'take imported' },
]

/**
 * A key that cannot collide across two rows, even when a malformed bundle
 * carries one identity twice — `librarySync.ts::rowKey`'s reasoning exactly:
 * it is the React key *and* the radio-group `name`, and native HTML radio
 * grouping is keyed by `name` alone, so two rows sharing one would unset
 * each other's picks. The index is safe to fold in because this list is
 * never reordered in place.
 */
export function importRowKey(row: LibraryImportRow, index: number): string {
  return `${row.kind}-${row.scope}-${row.project ?? ''}-${row.name}-${index}`
}

/** One line naming a preview status, for a row's badge. */
export function importStatusLabel(status: LibraryImportStatus): string {
  switch (status) {
    case 'new':
      return 'New here'
    case 'identical':
      return 'Identical'
    case 'conflict':
      return 'Conflict'
    case 'unresolvable':
      return 'Unresolvable'
  }
}

/** One sentence per status, saying what the import would actually do — the
 * modal shows this beside the diff so a pick is never a blind guess. */
export function importStatusExplains(status: LibraryImportStatus): string {
  switch (status) {
    case 'new':
      return 'Nothing here claims this item yet. Importing creates it.'
    case 'identical':
      return 'A row here already holds this item, byte for byte. There is nothing to decide.'
    case 'conflict':
      return 'A row here already holds this item with a different body. Keep the local one, or take the imported one — nothing is merged.'
    case 'unresolvable':
      return 'This item could not be matched against anything here, and importing it would fail the same way. There is nothing to pick between.'
  }
}

/**
 * True when this row is something the user picks a side for. Only a
 * `conflict` is: an `identical` row has nothing to choose between, a `new`
 * one has nothing to conflict with, and an `unresolvable` one has no local
 * row to keep. The `error === null` half is belt and braces — the server
 * pairs a non-null `error` with `unresolvable` — but this predicate governs
 * whether a radio is offered, so it refuses on either signal.
 */
export function isPickable(row: LibraryImportRow): boolean {
  return row.error === null && row.status === 'conflict'
}

/**
 * The choice a fresh modal pre-selects for a conflicting row: `skip`, the
 * batch-wide `on_conflict` default this replaces, and for the same reason
 * (`docs/library.md`) — a body the user already has, replaced out from under
 * them with no warning, is the more dangerous default. Taking the imported
 * one is opt-in, per item.
 */
export function defaultImportChoice(): ImportChoice {
  return 'skip'
}

/**
 * Which way a conflicting row's diff is read, for the side the pick ends
 * with — `librarySync.ts::diffOrientation`'s job on this surface, and kept
 * here rather than inline in the modal for the reason everything else in
 * this module is (CLAUDE.md: logic worth testing lives in a pure module).
 *
 * A straight two-way map, deliberately without sync's third "read older →
 * newer while nothing is picked" case: there, `skip` means *neither* side
 * wins and the dates are the only hint; here `skip` is itself a decision —
 * the local body wins — so there is always a side to read toward. The wire
 * names the local side `mesa` and the imported one `disk`
 * (`LibraryImportRow.diff`), so `replace` reads local → imported.
 */
export function importOrientation(choice: ImportChoice): DiffOrientation {
  return choice === 'replace' ? { from: 'mesa', to: 'disk' } : { from: 'disk', to: 'mesa' }
}

/** One entry of `POST /api/library/import`'s `resolutions` — the item's
 * identity, never its index in the bundle. */
export type ImportResolution = {
  name: string
  kind: LibraryImportRow['kind']
  scope: LibraryImportRow['scope']
  project: string | null
  choice: ImportChoice
}

/**
 * The `resolutions` array for `POST /api/library/import`: one entry per
 * pickable row, the rest omitted entirely — a `new` or `identical` row has
 * no conflict to resolve, and an unresolvable one would only fail twice.
 * `choices` holds whatever the user has explicitly picked, keyed by
 * `importRowKey`; a row missing from it falls back to `defaultImportChoice`,
 * so a batch nobody touched keeps every local body.
 */
export function importResolutionsFor(
  rows: LibraryImportRow[],
  choices: Record<string, ImportChoice>,
): ImportResolution[] {
  return rows
    .map((row, i) => ({ row, key: importRowKey(row, i) }))
    .filter(({ row }) => isPickable(row))
    .map(({ row, key }) => ({
      name: row.name,
      kind: row.kind,
      scope: row.scope,
      project: row.project,
      choice: choices[key] ?? defaultImportChoice(),
    }))
}

/** `n item(s) <word>` — the noun carries the plural, matching
 * `libraryBundle.ts`'s own summary clauses. */
function clause(n: number, word: string): string {
  return `${n} item${n === 1 ? '' : 's'} ${word}`
}

/**
 * The one-line summary of a preview, shown above the rows. A zero count is
 * omitted rather than printed, exactly as `summarizeImport` does for the
 * results. Every row is counted under its own status, `unresolvable`
 * included — which is why that is a status rather than a flag on a `new` row.
 */
export function summarizePreview(rows: LibraryImportRow[]): string {
  if (rows.length === 0) return 'Nothing to import.'
  const counts: Record<LibraryImportStatus, number> = {
    new: 0,
    identical: 0,
    conflict: 0,
    unresolvable: 0,
  }
  for (const row of rows) {
    counts[row.status] += 1
  }

  const parts: string[] = []
  if (counts.new > 0) parts.push(clause(counts.new, 'new'))
  if (counts.identical > 0) parts.push(clause(counts.identical, 'identical'))
  if (counts.conflict > 0) parts.push(clause(counts.conflict, 'conflicting'))
  if (counts.unresolvable > 0) parts.push(clause(counts.unresolvable, 'unresolvable'))
  return parts.join(', ') + '.'
}

/**
 * The two change dates as one short line above a row's diff — the local
 * row's own last change against the bundle's `exported_at`, which is
 * bundle-level and so passed in rather than carried per row. `librarySync`'s
 * `datesLabel` does the work, so this line reads exactly as a sync row's
 * does.
 */
export function importDatesLabel(row: LibraryImportRow, exportedAt: string): string | null {
  return datesLabel(
    ['local', row.local_updated_at],
    ['imported', exportedAt === '' ? null : exportedAt],
  )
}
