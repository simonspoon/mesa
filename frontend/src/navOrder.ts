// Drop-intent math for the left nav's drag-reorderable project tree
// (mesa tasks 666 and 669).
//
// This is the board's midpoint scheme (spec 328) lifted out of
// `KanbanBoard.tsx` into a module of its own, for the reason CLAUDE.md gives:
// a predicate that decides whether a write happens at all belongs somewhere
// vitest can reach it, not inline in a `.tsx` that only khora can exercise.
// The board keeps its own copy because its version also has to resolve a
// destination *column*; this one resolves a destination *parent*.
//
// Task 668 drew the nav as a tree but let a drag reorder within one parent's
// children only: a drop position alone carries no information about whether
// the user meant "put it beside this row" or "put it inside this row". Task
// 669 supplies that missing signal — **where in the row the drop landed** —
// so one drag expresses both. The edge zones (top/bottom quarter) mean
// *sibling of* the hovered row; the middle band means *child of* it. Both
// outcomes are one `PATCH /api/projects/{id}` carrying `parent_id` and
// `sort_order` together; no other row is renumbered.

/** The fields of a project this module cares about. */
export interface Orderable {
  id: number
  sort_order: number
  /** Task 668: `null` (or absent) is top level. */
  parent_id?: number | null
}

/** Which third of the hovered row the drop landed in. */
export type DropZone = 'before' | 'into' | 'after'

/** The patch a drop resolves to: the two fields, always written together. */
export interface DropIntent {
  parent_id: number | null
  sort_order: number
}

/**
 * The zone an offset within a row means: the top and bottom **quarters** are
 * the sibling edges, the middle **half** is "nest into".
 *
 * The middle is the widest band deliberately — it is the new gesture, and the
 * one whose target row is highlighted, so it should be the easy one to hit.
 * Out-of-range offsets are clamped rather than rejected: the pointer can sit
 * just outside a row the collision detection still resolved to.
 */
export function zoneForOffset(offsetY: number, height: number): DropZone {
  if (!(height > 0)) return 'into'
  const ratio = Math.min(1, Math.max(0, offsetY / height))
  if (ratio < 0.25) return 'before'
  if (ratio > 0.75) return 'after'
  return 'into'
}

/** `p`'s parent as the nav actually draws it: a `parent_id` naming no row in
 *  this array is top level, exactly as `buildTree` treats it. Keeps a drop
 *  onto a live child of an archived parent from adopting the hidden row. */
function parentOf(present: Set<number>, p: Orderable): number | null {
  const parent = p.parent_id ?? null
  return parent !== null && present.has(parent) ? parent : null
}

/** Ids under `id` at any depth, `id` excluded. Cycle-safe (a malformed
 *  `parent_id` loop in the input must not hang the drag). */
function descendantsOf(projects: Orderable[], id: number): Set<number> {
  const present = new Set(projects.map((p) => p.id))
  const out = new Set<number>()
  const stack = [id]
  const seen = new Set<number>([id])
  while (stack.length > 0) {
    const parent = stack.pop()!
    for (const p of projects) {
      if (parentOf(present, p) !== parent || seen.has(p.id)) continue
      seen.add(p.id)
      out.add(p.id)
      stack.push(p.id)
    }
  }
  return out
}

/** The midpoint scheme: the value that lands between `prev` and `next`, so
 *  the neighbours keep the values they had and one drag stays one write. */
function between(prev: number | null, next: number | null): number {
  if (prev === null && next === null) return 1
  if (prev === null) return next! - 1
  if (next === null) return prev + 1
  return (prev + next) / 2
}

/**
 * What to PATCH onto `activeId` when it is dropped on `overId` in `zone`, or
 * `null` when the drop is a no-op or impossible and no request should be sent.
 *
 * `projects` must be in rendered order — i.e. already sorted the way the
 * server returned them, which `GET /api/projects` guarantees is
 * `ORDER BY sort_order, id`.
 *
 * - `'before'` / `'after'` make the dragged project a **sibling** of the
 *   hovered row, immediately before or after it: it takes that row's parent
 *   and the midpoint of the two rows it lands between. This generalises the
 *   old reorder — dropping on the edge of a top-level row is how a nested
 *   project is pulled back out to top level.
 * - `'into'` makes it a **child** of the hovered row, appended last among
 *   that row's existing children (`MAX(sort_order) + 1`, seeded to 1 when
 *   there are none).
 * - An `overId` naming no row (the list's own droppable) means the end of the
 *   **top-level** list, whatever zone the pointer was in.
 *
 * `null` — no request at all — for: a drop onto itself; a drop onto its own
 * descendant at any depth (a cycle `Store` would answer with a 409, and a move
 * that can only fail is not one to offer); and any drop that resolves to the
 * position the project already holds.
 */
export function dropIntentFor(
  projects: Orderable[],
  activeId: number,
  overId: number,
  zone: DropZone,
): DropIntent | null {
  const active = projects.find((p) => p.id === activeId)
  if (!active || activeId === overId) return null
  const present = new Set(projects.map((p) => p.id))
  const activeParent = parentOf(present, active)

  const over = projects.find((p) => p.id === overId)
  // Dropped on no row at all: the end of the top-level list.
  if (!over) {
    const roots = projects.filter((p) => parentOf(present, p) === null)
    // Already the last top-level row: nothing to write.
    if (activeParent === null && roots[roots.length - 1]?.id === activeId) return null
    const rest = roots.filter((p) => p.id !== activeId)
    return {
      parent_id: null,
      sort_order: between(rest.length > 0 ? rest[rest.length - 1].sort_order : null, null),
    }
  }

  // Never offer a move `Store` can only reject.
  if (descendantsOf(projects, activeId).has(overId)) return null

  if (zone === 'into') {
    const children = projects.filter((p) => parentOf(present, p) === overId)
    // Already this row's last child: dropping in changes nothing.
    if (activeParent === overId && children[children.length - 1]?.id === activeId) return null
    const others = children.filter((p) => p.id !== activeId)
    const max = others.reduce<number | null>(
      (m, p) => (m === null || p.sort_order > m ? p.sort_order : m),
      null,
    )
    return { parent_id: overId, sort_order: max === null ? 1 : max + 1 }
  }

  const parent = parentOf(present, over)
  // The sibling list as it will look without the dragged row — the same basis
  // the board uses, so "insert before the row I was hovering" means the same
  // thing whether the drag went up or down.
  const rest = projects.filter((p) => p.id !== activeId && parentOf(present, p) === parent)
  const overIndex = rest.findIndex((p) => p.id === overId)
  const insertAt = zone === 'before' ? overIndex : overIndex + 1
  const prev = insertAt > 0 ? rest[insertAt - 1].sort_order : null
  const next = insertAt < rest.length ? rest[insertAt].sort_order : null
  const sortOrder = between(prev, next)

  // Dropping a row back where it started must issue no request. Both halves
  // matter: the same number under a *different* parent is a real move.
  if (parent === activeParent && sortOrder === active.sort_order) return null
  return { parent_id: parent, sort_order: sortOrder }
}
