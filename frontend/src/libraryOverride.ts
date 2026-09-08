import type { LibraryDiffKind } from './types/LibraryDiffKind'
import type { LibraryDiffLine } from './types/LibraryDiffLine'
import type { LibraryItem } from './types/LibraryItem'

/**
 * Pure decisions for the Library page's item list: folding a user row and the
 * built-in it shadows by *name* into one row, and diffing the two bodies.
 *
 * `core::library::effective_items` shadows a built-in only through a db row's
 * `builtin_id` — a fork. A row that merely collides by `(kind, scope, name)`
 * (one adopted from disk by a sync, say) leaves both in the list, and the file
 * on disk can only ever be one of them. That pair is what `foldOverrides`
 * folds: the built-in is dropped and the user row says it overrides one.
 *
 * `diffLines` is a **deliberate second implementation** of
 * `core::library::diff_lines` (`src/core/library.rs`). Both bodies are already
 * in the browser — they arrive on the list `GET /api/library` makes — so
 * asking the server would mean a new gated route for data the page holds, to
 * answer a question that is pure text. The two implementations must stay in
 * step: same line-splitting semantics, the same tie-break, and the same two
 * bounds degrading to the same marker line. Change one, change the other.
 */

/** The most lines one diff carries, mirroring `core::library::DIFF_MAX_LINES`. */
export const DIFF_MAX_LINES = 2000

/** The largest LCS table `diffLines` will build, mirroring
 * `core::library::DIFF_MAX_CELLS`. */
export const DIFF_MAX_CELLS = 16_000_000

/** Identifies one row in the list regardless of whether it is a stored item
 * or an unshadowed built-in (`id: null`) — the key the editing/versions
 * state is keyed by, since a plain numeric id cannot name a built-in. */
export function itemKey(item: LibraryItem): string {
  return item.id !== null ? `id:${item.id}` : `builtin:${item.builtin_id}`
}

/** What `foldOverrides` answers: the list with each name-shadowed built-in
 * removed, and the body of the built-in each surviving user row overrode,
 * keyed by that row's `itemKey`. */
export type FoldedItems = {
  items: LibraryItem[]
  overriddenBody: Map<string, string>
}

/** `kind`/`scope`/`name`, the triple the db's own uniqueness rule is stated
 * in — so the match here is exact and **case-sensitive**, exactly as two rows
 * are judged to collide on the server. */
function collisionKey(item: LibraryItem): string {
  return `${item.kind} ${item.scope} ${item.name}`
}

/**
 * Folds each built-in that a purely user-authored row (`builtin_id === null`)
 * shadows by name out of the list, reporting the built-in's body against the
 * surviving row.
 *
 * A **fork** (`builtin_id !== null`) is left exactly as it is: the built-in it
 * came from is already absent from the list, so there is nothing to fold and
 * nothing in the browser to diff it against.
 */
export function foldOverrides(items: LibraryItem[]): FoldedItems {
  const builtins = new Map<string, LibraryItem>()
  for (const item of items) {
    if (item.builtin) builtins.set(collisionKey(item), item)
  }

  const overriddenBody = new Map<string, string>()
  const shadowed = new Set<LibraryItem>()
  for (const item of items) {
    if (item.builtin || item.builtin_id !== null) continue
    const builtin = builtins.get(collisionKey(item))
    if (builtin === undefined) continue
    overriddenBody.set(itemKey(item), builtin.body)
    shadowed.add(builtin)
  }

  return { items: items.filter((i) => !shadowed.has(i)), overriddenBody }
}

/** Rust's `str::lines`: split on a newline, drop a trailing carriage return,
 * and a trailing newline is not a line of its own. */
function lines(body: string): string[] {
  const out = body.split('\n')
  if (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
}

/** One diff line, taking the 0-based indices the walk holds and reporting the
 * 1-based numbers the row carries. */
function line(
  kind: LibraryDiffKind,
  mesa: number | null,
  disk: number | null,
  text: string,
): LibraryDiffLine {
  return {
    kind,
    mesa_line: mesa === null ? null : mesa + 1,
    disk_line: disk === null ? null : disk + 1,
    text,
  }
}

/** A line that is not content from either side — how `diffLines` reports that
 * it stopped rather than silently answering short. */
function marker(text: string): LibraryDiffLine {
  return { kind: 'context', mesa_line: null, disk_line: null, text }
}

/**
 * The line-level diff of two bodies: a hand-rolled LCS over lines, the port of
 * `core::library::diff_lines` described in this module's header. Line numbers
 * are 1-based and only ever set on the side a line exists in. The result is
 * bounded twice — a table over `DIFF_MAX_CELLS` is not built at all, and a
 * result past `DIFF_MAX_LINES` is cut — and both degrade to a *marker* line
 * rather than an error or an unbounded answer.
 */
export function diffLines(mesa: string, disk: string): LibraryDiffLine[] {
  const a = lines(mesa)
  const b = lines(disk)
  if ((a.length + 1) * (b.length + 1) > DIFF_MAX_CELLS) {
    return [marker(`… diff not computed: ${a.length} lines in mesa, ${b.length} on disk …`)]
  }

  // `lcs[i * w + j]` = the length of the longest common subsequence of
  // `a[i..]` and `b[j..]`, filled from the end so the walk below can read it
  // forwards. One flat row-major buffer, width `b.length + 1`.
  const w = b.length + 1
  const lcs = new Uint32Array((a.length + 1) * w)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * w + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * w + j + 1] + 1
          : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1])
    }
  }

  const out: LibraryDiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(line('context', i, j, a[i]))
      i++
      j++
    } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
      out.push(line('mesa-only', i, null, a[i]))
      i++
    } else {
      out.push(line('disk-only', null, j, b[j]))
      j++
    }
  }
  while (i < a.length) {
    out.push(line('mesa-only', i, null, a[i]))
    i++
  }
  while (j < b.length) {
    out.push(line('disk-only', null, j, b[j]))
    j++
  }

  if (out.length > DIFF_MAX_LINES) {
    const dropped = out.length - DIFF_MAX_LINES
    out.length = DIFF_MAX_LINES
    out.push(marker(`… ${dropped} more diff lines not shown …`))
  }
  return out
}
