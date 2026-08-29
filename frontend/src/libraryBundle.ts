import type { LibraryBundle } from './types/LibraryBundle'
import type { LibraryBundleItem } from './types/LibraryBundleItem'
import type { LibraryImportResult } from './types/LibraryImportResult'
import type { LibraryKind } from './types/LibraryKind'
import type { LibraryScope } from './types/LibraryScope'
import { LIBRARY_KINDS, LIBRARY_SCOPES } from './libraryDraft'

/**
 * Pure logic for the Library page's Import/Export controls, hoisted out of
 * `LibraryView.tsx` so it is unit-testable (CLAUDE.md: the frontend tests
 * cover the pure logic modules, never a rendered tree) — the
 * `libraryDraft.ts`/`librarySync.ts` pattern (mesa task 963,
 * `.scratch/963-export-import-spec.md`).
 */

/** The one bundle format this build knows how to import — mirrors
 * `core::library::import`'s all-or-nothing version check. */
export const BUNDLE_VERSION = 1

/** The downloaded bundle's filename: `mesa-library-<date>.json` — the
 * Library page has no project-scope concept (its export is always
 * unscoped), so there is nothing to qualify it with. `now` is passed in
 * rather than read here so the result is deterministic and testable. */
export function bundleFilename(now: Date): string {
  const date = now.toISOString().slice(0, 10)
  return `mesa-library-${date}.json`
}

export type ParsedBundle = { bundle: LibraryBundle } | { error: string }

/** One item's shape complaint, or `null` if it passes — checked against the
 * required fields `LibraryBundleItem` carries on the wire (`name`, `kind`,
 * `scope`, `body`); `project`/`builtin_id` are optional-shaped (nullable)
 * so a missing or wrongly-typed value there is just treated as absent
 * rather than rejecting the whole file. */
function itemError(item: unknown, index: number): string | null {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return `Item ${index} is not an object.`
  }
  const it = item as Record<string, unknown>
  if (typeof it.name !== 'string' || it.name === '') {
    return `Item ${index} is missing a "name".`
  }
  if (typeof it.kind !== 'string' || !LIBRARY_KINDS.includes(it.kind as LibraryKind)) {
    return `Item ${index} ("${it.name}") has a missing or unrecognized "kind".`
  }
  if (typeof it.scope !== 'string' || !LIBRARY_SCOPES.includes(it.scope as LibraryScope)) {
    return `Item ${index} ("${it.name}") has a missing or unrecognized "scope".`
  }
  if (typeof it.body !== 'string') {
    return `Item ${index} ("${it.name}") is missing a "body".`
  }
  return null
}

/**
 * Parses and validates a bundle file's text. Total — never throws — so the
 * page can show whatever comes back directly in its error affordance. Only
 * checks the shape a client can usefully catch before the round trip; the
 * server still re-validates (an unknown project name, the body cap, …) on
 * import itself.
 */
export function parseBundle(text: string): ParsedBundle {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { error: 'That file is not valid JSON.' }
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { error: 'A library bundle must be a JSON object.' }
  }
  const obj = data as Record<string, unknown>

  if (typeof obj.version !== 'number') {
    return { error: 'The bundle is missing a numeric "version" field.' }
  }
  if (obj.version !== BUNDLE_VERSION) {
    return {
      error: `Unknown bundle version ${obj.version} — this mesa understands version ${BUNDLE_VERSION}.`,
    }
  }
  if (!Array.isArray(obj.items)) {
    return { error: 'The bundle is missing an "items" array.' }
  }

  for (let i = 0; i < obj.items.length; i++) {
    const err = itemError(obj.items[i], i)
    if (err !== null) return { error: err }
  }

  const items: LibraryBundleItem[] = (obj.items as Record<string, unknown>[]).map((it) => ({
    name: it.name as string,
    kind: it.kind as LibraryKind,
    scope: it.scope as LibraryScope,
    project: typeof it.project === 'string' ? it.project : null,
    body: it.body as string,
    builtin_id: typeof it.builtin_id === 'string' ? it.builtin_id : null,
  }))

  return {
    bundle: {
      version: obj.version,
      exported_at: typeof obj.exported_at === 'string' ? obj.exported_at : '',
      items,
    },
  }
}

/** `n item(s) <status>` — the noun that carries the plural, not the status
 * word, since every status is a past participle already ("created" reads
 * the same whether one item or ten hit it). */
function clause(n: number, status: string): string {
  return `${n} item${n === 1 ? '' : 's'} ${status}`
}

/**
 * The one-line created/replaced/skipped/failed summary shown after an
 * import — a zero count is omitted rather than printed as "0 items X".
 */
export function summarizeImport(results: LibraryImportResult[]): string {
  const counts = { created: 0, replaced: 0, skipped: 0, failed: 0 }
  for (const r of results) {
    if (r.status === 'created' || r.status === 'replaced' || r.status === 'skipped' || r.status === 'failed') {
      counts[r.status]++
    }
  }

  const parts: string[] = []
  if (counts.created > 0) parts.push(clause(counts.created, 'created'))
  if (counts.replaced > 0) parts.push(clause(counts.replaced, 'replaced'))
  if (counts.skipped > 0) parts.push(clause(counts.skipped, 'skipped'))
  if (counts.failed > 0) parts.push(clause(counts.failed, 'failed'))

  if (parts.length === 0) return 'Nothing to import.'
  return parts.join(', ') + '.'
}
