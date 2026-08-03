// Drop-position math for the left nav's drag-reorderable project list
// (mesa task 666).
//
// This is the board's midpoint scheme (spec 328) lifted out of
// `KanbanBoard.tsx` into a module of its own, for the reason CLAUDE.md gives:
// a predicate that decides whether a write happens at all belongs somewhere
// vitest can reach it, not inline in a `.tsx` that only khora can exercise.
// The board keeps its own copy because its version also has to resolve a
// destination *column*; this one only ever reorders within one list.

/** The one field of a project this module cares about. */
export interface Orderable {
  id: number
  sort_order: number
}

/**
 * The `sort_order` to PATCH onto `activeId` when it is dropped on `overId`,
 * or `null` when the drop is a no-op and no request should be sent.
 *
 * `projects` must be in rendered order — i.e. already sorted the way the
 * server returned them, which `GET /api/projects` guarantees is
 * `ORDER BY sort_order, id`.
 *
 * The value is the midpoint of the two rows the dragged one lands between,
 * so one drag is one write: the neighbours keep the values they had. At the
 * head there is no `prev`, so it is `next - 1`; at the tail no `next`, so
 * `prev + 1`.
 */
export function sortOrderForDrop(
  projects: Orderable[],
  activeId: number,
  overId: number,
): number | null {
  const active = projects.find((p) => p.id === activeId)
  if (!active || activeId === overId) return null

  // The list as it will look without the dragged row — the same basis the
  // board uses, so "insert before the row I was hovering" means the same
  // thing whether the drag went up or down.
  const rest = projects.filter((p) => p.id !== activeId)
  const overIndex = rest.findIndex((p) => p.id === overId)
  // An unknown `over` (dropped on the list's own droppable, not on a row)
  // means the end of the list.
  const insertAt = overIndex === -1 ? rest.length : overIndex

  const prev = insertAt > 0 ? rest[insertAt - 1].sort_order : null
  const next = insertAt < rest.length ? rest[insertAt].sort_order : null
  const sortOrder =
    prev === null && next === null
      ? 1
      : prev === null
        ? next! - 1
        : next === null
          ? prev + 1
          : (prev + next) / 2

  // Dropping a row back where it started must issue no request.
  return sortOrder === active.sort_order ? null : sortOrder
}
